package hetzner_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pdatahub/pdatahub/runner/internal/hetzner"
)

// sampleServerOpts returns a canonical ServerCreateOpts used by most tests.
func sampleServerOpts() hetzner.ServerCreateOpts {
	return hetzner.ServerCreateOpts{
		Name:       "u-abc123",
		ServerType: "cx22",
		Image:      "ubuntu-24.04",
		Region:     "fsn1",
		SSHKeys:    []int64{1},
		Labels: map[string]string{
			hetzner.LabelManagedBy: hetzner.DefaultManagedBy,
			hetzner.LabelUserID:    "u-abc123",
		},
	}
}

func newFastMock() *hetzner.MockHetzner {
	m := hetzner.NewMockHetzner()
	m.SetLatency(0)
	return m
}

// Compile-time interface contract test: MockHetzner must satisfy Client.
func TestMockHetzner_ImplementsClient(t *testing.T) {
	var _ hetzner.Client = (*hetzner.MockHetzner)(nil)
}

func TestServerStatus_IsValid(t *testing.T) {
	for _, s := range []hetzner.ServerStatus{
		hetzner.ServerStatusInitializing,
		hetzner.ServerStatusRunning,
		hetzner.ServerStatusOffline,
	} {
		assert.True(t, s.IsValid(), "status=%q", s)
	}
	assert.False(t, hetzner.ServerStatus("").IsValid())
	assert.False(t, hetzner.ServerStatus("starting").IsValid())
}

func TestArchitecture_IsValid(t *testing.T) {
	assert.True(t, hetzner.ArchX86.IsValid())
	assert.True(t, hetzner.ArchARM.IsValid())
	assert.False(t, hetzner.Architecture("").IsValid())
	assert.False(t, hetzner.Architecture("riscv").IsValid())
}

func TestServerCreateOpts_Validate(t *testing.T) {
	good := sampleServerOpts()
	require.NoError(t, good.Validate())

	cases := []struct {
		name   string
		mutate func(*hetzner.ServerCreateOpts)
	}{
		{"empty name", func(o *hetzner.ServerCreateOpts) { o.Name = "" }},
		{"empty server type", func(o *hetzner.ServerCreateOpts) { o.ServerType = "" }},
		{"empty image", func(o *hetzner.ServerCreateOpts) { o.Image = "" }},
		{"empty region", func(o *hetzner.ServerCreateOpts) { o.Region = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := good
			tc.mutate(&o)
			require.Error(t, o.Validate())
		})
	}
}

func TestSSHKeyCreateOpts_Validate(t *testing.T) {
	good := hetzner.SSHKeyCreateOpts{Name: "k1", PublicKey: "ssh-ed25519 AAAA..."}
	require.NoError(t, good.Validate())

	bad := hetzner.SSHKeyCreateOpts{PublicKey: "x"}
	require.Error(t, bad.Validate())
	bad2 := hetzner.SSHKeyCreateOpts{Name: "k1"}
	require.Error(t, bad2.Validate())
}

func TestMock_CreateServer_AssignsDeterministicFields(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()

	s, err := m.CreateServer(ctx, sampleServerOpts())
	require.NoError(t, err)
	require.NotNil(t, s)

	assert.Equal(t, int64(1), s.ID, "first ID should be 1")
	assert.Equal(t, "u-abc123", s.Name)
	assert.Equal(t, hetzner.ServerStatusInitializing, s.Status)
	assert.Equal(t, "cx22", s.ServerType)
	assert.Equal(t, "fsn1", s.Datacenter)
	assert.NotEmpty(t, s.PublicIPv4)
	assert.NotEmpty(t, s.PrivateIPv4)
	assert.NotEqual(t, s.PublicIPv4, s.PrivateIPv4)
	assert.Equal(t, hetzner.DefaultManagedBy, s.Labels[hetzner.LabelManagedBy])
	assert.Equal(t, "u-abc123", s.Labels[hetzner.LabelUserID])
	assert.Greater(t, s.CreatedAt, int64(0))

	// Second server with a distinct name gets ID 2 and a different IP.
	opts2 := sampleServerOpts()
	opts2.Name = "u-def456"
	opts2.Labels = map[string]string{
		hetzner.LabelManagedBy: hetzner.DefaultManagedBy,
		hetzner.LabelUserID:    "u-def456",
	}
	s2, err := m.CreateServer(ctx, opts2)
	require.NoError(t, err)
	assert.Equal(t, int64(2), s2.ID)
	assert.NotEqual(t, s.PublicIPv4, s2.PublicIPv4)
}

func TestMock_CreateServer_AutoFillsManagedBy(t *testing.T) {
	m := newFastMock()
	opts := sampleServerOpts()
	delete(opts.Labels, hetzner.LabelManagedBy)

	s, err := m.CreateServer(context.Background(), opts)
	require.NoError(t, err)
	assert.Equal(t, hetzner.DefaultManagedBy, s.Labels[hetzner.LabelManagedBy])
}

func TestMock_CreateServer_RejectsDuplicateName(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()
	_, err := m.CreateServer(ctx, sampleServerOpts())
	require.NoError(t, err)

	_, err = m.CreateServer(ctx, sampleServerOpts())
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrInvalidInput), "expected ErrInvalidInput, got %v", err)
}

func TestMock_CreateServer_RejectsInvalidInput(t *testing.T) {
	m := newFastMock()
	_, err := m.CreateServer(context.Background(), hetzner.ServerCreateOpts{Name: ""})
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrInvalidInput))
}

func TestMock_CreateServer_RespectsContextCancellation(t *testing.T) {
	m := hetzner.NewMockHetzner() // keep default latency
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	_, err := m.CreateServer(ctx, sampleServerOpts())
	require.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestMock_CreateServer_RespectsErrorInjection(t *testing.T) {
	m := newFastMock()
	boom := errors.New("simulated outage")
	m.SetInjectError("CreateServer", boom)

	_, err := m.CreateServer(context.Background(), sampleServerOpts())
	require.ErrorIs(t, err, boom)

	// One-shot: subsequent calls succeed.
	_, err = m.CreateServer(context.Background(), sampleServerOpts())
	require.NoError(t, err)
}

func TestMock_GetServer_RoundTrip(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()
	created, err := m.CreateServer(ctx, sampleServerOpts())
	require.NoError(t, err)

	got, err := m.GetServer(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, created.Name, got.Name)
	assert.Equal(t, created.PublicIPv4, got.PublicIPv4)
	assert.Equal(t, created.Labels, got.Labels)
}

func TestMock_GetServer_NotFound(t *testing.T) {
	m := newFastMock()
	_, err := m.GetServer(context.Background(), 999)
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrNotFound))
}

func TestMock_DeleteServer_RemovesAndIsIdempotent(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()
	s, err := m.CreateServer(ctx, sampleServerOpts())
	require.NoError(t, err)

	require.NoError(t, m.DeleteServer(ctx, s.ID))
	_, err = m.GetServer(ctx, s.ID)
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrNotFound))

	// Idempotent: deleting again is OK.
	require.NoError(t, m.DeleteServer(ctx, s.ID))
	require.NoError(t, m.DeleteServer(ctx, 9999)) // unknown ID also OK
}

func TestMock_ListServers_FiltersByLabels(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()

	optsA := sampleServerOpts()
	optsA.Name = "u-aaa"
	optsA.Labels = map[string]string{
		hetzner.LabelManagedBy: hetzner.DefaultManagedBy,
		hetzner.LabelUserID:    "u-aaa",
	}
	optsB := sampleServerOpts()
	optsB.Name = "u-bbb"
	optsB.Labels = map[string]string{
		hetzner.LabelManagedBy: hetzner.DefaultManagedBy,
		hetzner.LabelUserID:    "u-bbb",
	}

	_, err := m.CreateServer(ctx, optsA)
	require.NoError(t, err)
	_, err = m.CreateServer(ctx, optsB)
	require.NoError(t, err)

	all, err := m.ListServers(ctx, nil)
	require.NoError(t, err)
	assert.Len(t, all, 2)

	filtered, err := m.ListServers(ctx, map[string]string{hetzner.LabelUserID: "u-aaa"})
	require.NoError(t, err)
	require.Len(t, filtered, 1)
	assert.Equal(t, "u-aaa", filtered[0].Name)

	// Non-matching label returns empty slice.
	none, err := m.ListServers(ctx, map[string]string{hetzner.LabelUserID: "u-zzz"})
	require.NoError(t, err)
	assert.Empty(t, none)
}

func TestMock_ListServers_ANDSemantics(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()

	opts := sampleServerOpts()
	opts.Name = "u-and"
	opts.Labels = map[string]string{
		hetzner.LabelManagedBy:   hetzner.DefaultManagedBy,
		hetzner.LabelUserID:      "u-and",
		hetzner.LabelHubInstance: "h-1",
	}
	_, err := m.CreateServer(ctx, opts)
	require.NoError(t, err)

	// Both labels present: match.
	out, err := m.ListServers(ctx, map[string]string{
		hetzner.LabelUserID:      "u-and",
		hetzner.LabelHubInstance: "h-1",
	})
	require.NoError(t, err)
	assert.Len(t, out, 1)

	// One label mismatched: empty.
	out, err = m.ListServers(ctx, map[string]string{
		hetzner.LabelUserID:      "u-and",
		hetzner.LabelHubInstance: "h-2",
	})
	require.NoError(t, err)
	assert.Empty(t, out)
}

func TestMock_ListServers_StableOrder(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		opts := sampleServerOpts()
		opts.Name = fmt.Sprintf("u-%02d", i)
		_, err := m.CreateServer(ctx, opts)
		require.NoError(t, err)
	}

	first, err := m.ListServers(ctx, nil)
	require.NoError(t, err)
	second, err := m.ListServers(ctx, nil)
	require.NoError(t, err)
	require.Len(t, first, len(second))

	for i := range first {
		assert.Equal(t, first[i].ID, second[i].ID, "position %d", i)
	}
}

func TestMock_CreateSSHKey_AssignsIDAndFingerprint(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()

	k1, err := m.CreateSSHKey(ctx, hetzner.SSHKeyCreateOpts{
		Name:      "runner-key-1",
		PublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAliceKey user@host",
	})
	require.NoError(t, err)
	require.NotNil(t, k1)
	assert.Equal(t, int64(1), k1.ID)
	assert.NotEmpty(t, k1.Fingerprint)
	assert.True(t, len(k1.Fingerprint) > len("SHA256:"), "fingerprint should have base64 payload")
	assert.Contains(t, k1.Fingerprint, "SHA256:")
	assert.Equal(t, "runner-key-1", k1.Name)

	// Second key gets a different fingerprint (deterministic on input).
	k2, err := m.CreateSSHKey(ctx, hetzner.SSHKeyCreateOpts{
		Name:      "runner-key-2",
		PublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBobKey user@host",
	})
	require.NoError(t, err)
	assert.NotEqual(t, k1.Fingerprint, k2.Fingerprint)
	assert.Equal(t, int64(2), k2.ID)
}

func TestMock_CreateSSHKey_RejectsInvalidInput(t *testing.T) {
	m := newFastMock()
	_, err := m.CreateSSHKey(context.Background(), hetzner.SSHKeyCreateOpts{})
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrInvalidInput))
}

func TestMock_CreateSSHKey_RejectsDuplicateName(t *testing.T) {
	m := newFastMock()
	ctx := context.Background()
	_, err := m.CreateSSHKey(ctx, hetzner.SSHKeyCreateOpts{Name: "k", PublicKey: "x"})
	require.NoError(t, err)
	_, err = m.CreateSSHKey(ctx, hetzner.SSHKeyCreateOpts{Name: "k", PublicKey: "y"})
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrInvalidInput))
}

func TestMock_GetImage_ByNameAndID(t *testing.T) {
	m := newFastMock()
	img, err := m.GetImage(context.Background(), "ubuntu-24.04")
	require.NoError(t, err)
	assert.Equal(t, "ubuntu-24.04", img.Name)
	assert.Equal(t, hetzner.ArchX86, img.Architecture)

	img, err = m.GetImage(context.Background(), "1")
	require.NoError(t, err)
	assert.Equal(t, int64(1), img.ID)

	_, err = m.GetImage(context.Background(), "missing-image")
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrNotFound))
}

func TestMock_GetImage_RespectsErrorInjection(t *testing.T) {
	m := newFastMock()
	boom := errors.New("simulated")
	m.SetInjectError("GetImage", boom)

	_, err := m.GetImage(context.Background(), "ubuntu-24.04")
	require.ErrorIs(t, err, boom)
}

func TestMock_ConcurrentCreateServer_AssignsDistinctIDs(t *testing.T) {
	m := newFastMock()
	const N = 25

	var wg sync.WaitGroup
	ids := make(chan int64, N)
	errs := make(chan error, N)

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			opts := sampleServerOpts()
			opts.Name = fmt.Sprintf("u-%03d", i)
			s, err := m.CreateServer(context.Background(), opts)
			if err != nil {
				errs <- err
				return
			}
			ids <- s.ID
		}(i)
	}
	wg.Wait()
	close(ids)
	close(errs)

	for err := range errs {
		t.Fatalf("unexpected error: %v", err)
	}

	seen := make(map[int64]bool)
	for id := range ids {
		assert.False(t, seen[id], "duplicate id %d", id)
		seen[id] = true
	}
	assert.Len(t, seen, N)
	assert.Equal(t, N, m.ServerCount())
}

func TestMock_LabelMutationDoesNotLeak(t *testing.T) {
	m := newFastMock()
	opts := sampleServerOpts()
	opts.Labels = map[string]string{hetzner.LabelUserID: "u-leak"}

	s1, err := m.CreateServer(context.Background(), opts)
	require.NoError(t, err)

	// Mutate the caller's labels — should not affect stored state.
	opts.Labels["pdatahub-injected-after"] = "true"

	s2, err := m.GetServer(context.Background(), s1.ID)
	require.NoError(t, err)
	assert.NotContains(t, s2.Labels, "pdatahub-injected-after", "label mutation must not leak across calls")
}

func TestMock_DefaultLatency_IsApplied(t *testing.T) {
	m := hetzner.NewMockHetzner() // not FastMock — keep default
	start := time.Now()
	_, err := m.CreateServer(context.Background(), sampleServerOpts())
	elapsed := time.Since(start)
	require.NoError(t, err)
	// Generous bound: 50ms ± sched jitter.
	assert.GreaterOrEqual(t, elapsed, hetzner.DefaultMockLatency)
	assert.Less(t, elapsed, 250*time.Millisecond, "default latency should be ~50ms, got %v", elapsed)
}

func TestMock_ClearInjections(t *testing.T) {
	m := newFastMock()
	m.SetInjectError("CreateServer", errors.New("boom"))
	m.SetInjectError("GetServer", errors.New("boom2"))
	m.SetInjectError("", nil) // clear all

	// Both ops should now succeed.
	_, err := m.CreateServer(context.Background(), sampleServerOpts())
	require.NoError(t, err)
	_, err = m.GetServer(context.Background(), 999)
	// 999 is unknown — error is ErrNotFound, not the injected boom.
	require.Error(t, err)
	assert.True(t, errors.Is(err, hetzner.ErrNotFound))
}

func TestAsError(t *testing.T) {
	assert.Nil(t, hetzner.AsError("CreateServer", nil))
	err := hetzner.AsError("CreateServer", errors.New("inner"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "hetzner.CreateServer")
	assert.Contains(t, err.Error(), "inner")
}