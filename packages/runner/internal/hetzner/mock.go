package hetzner

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// MockHetzner is an in-memory implementation of Client used in tests and in
// --dry-run mode of the runner binary.
//
// Properties:
//   - Deterministic: auto-incrementing IDs (1, 2, 3, ...) and a deterministic
//     IP allocator seeded from the ID.
//   - Concurrent-safe: sync.RWMutex around the entire state.
//   - Failure-injectable: SetInjectError("CreateServer", errors.New("boom"))
//     makes the next call to that op return that error.
//   - Latency-tunable: default 50ms per op, set to 0 with SetLatency(0) for
//     fast tests.
//
// Phase 1B: keep this mock in lockstep with the real hcloud-go-backed Client
// so tests against the interface still pass when swapped.
type MockHetzner struct {
	mu sync.RWMutex

	nextID    atomic.Int64
	nextSSHID atomic.Int64

	servers map[int64]*Server
	sshKeys map[int64]*SSHKey
	images  map[string]*Image // keyed by "<name>/<arch>"
	imgByID map[int64]*Image

	// latency is the artificial delay applied to every operation.
	// Use SetLatency to change. Default is DefaultMockLatency.
	latency time.Duration

	// injectErrors maps operation names (e.g. "CreateServer") to the error
	// to return on the next call. The error is consumed (one-shot) and removed.
	injectErrors map[string]error

	// ipSeq allocates deterministic IPv4s from 10.0.0.0/24 and 10.0.1.0/24.
	// Phase 1B callers shouldn't depend on the format — it's purely for
	// human inspection.
	ipSeq atomic.Int64
}

const (
	// DefaultMockLatency is the simulated Hetzner API latency per operation.
	// 50ms matches the p95 latency we observed against the real API in dev.
	DefaultMockLatency = 50 * time.Millisecond
)

// NewMockHetzner returns a MockHetzner pre-populated with a small set of well-
// known images so GetImage works without explicit seeding in tests.
func NewMockHetzner() *MockHetzner {
	m := &MockHetzner{
		servers:      make(map[int64]*Server),
		sshKeys:      make(map[int64]*SSHKey),
		images:       make(map[string]*Image),
		imgByID:      make(map[int64]*Image),
		latency:      DefaultMockLatency,
		injectErrors: make(map[string]error),
	}
	m.seedImages()
	return m
}

// SetLatency overrides the simulated API latency. Set to 0 for fast tests.
func (m *MockHetzner) SetLatency(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.latency = d
}

// SetInjectError makes the next call to op return err (and remove the entry).
// An empty op clears all pending injections.
func (m *MockHetzner) SetInjectError(op string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if op == "" {
		m.injectErrors = make(map[string]error)
		return
	}
	m.injectErrors[op] = err
}

// ServerCount returns the number of currently tracked servers. Test helper.
func (m *MockHetzner) ServerCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.servers)
}

// SSHKeyCount returns the number of currently tracked SSH keys. Test helper.
func (m *MockHetzner) SSHKeyCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sshKeys)
}

func (m *MockHetzner) takeInjectedError(op string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	err, ok := m.injectErrors[op]
	if ok {
		delete(m.injectErrors, op)
	}
	return err
}

func (m *MockHetzner) sleep(ctx context.Context) error {
	if m.latency <= 0 {
		return nil
	}
	t := time.NewTimer(m.latency)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (m *MockHetzner) seedImages() {
	wellKnown := []*Image{
		{ID: 1, Name: "ubuntu-24.04", Architecture: ArchX86},
		{ID: 2, Name: "ubuntu-24.04", Architecture: ArchARM},
		{ID: 3, Name: "debian-12", Architecture: ArchX86},
		{ID: 4, Name: "debian-12", Architecture: ArchARM},
	}
	for _, img := range wellKnown {
		m.images[imageKey(img.Name, img.Architecture)] = img
		m.imgByID[img.ID] = img
	}
}

func imageKey(name string, arch Architecture) string {
	return name + "/" + string(arch)
}

func (m *MockHetzner) nextIP() string {
	seq := m.ipSeq.Add(1)
	return net.IPv4(10, 0, 0, byte(2+seq-1)).String()
}

func (m *MockHetzner) nextPrivateIP() string {
	seq := m.ipSeq.Add(1)
	return net.IPv4(10, 0, 1, byte(2+seq-1)).String()
}

// fingerprint computes SHA256:<base64> like `ssh-keygen -lf`. Matches the
// format OpenSSH prints for SSH key fingerprints.
func fingerprint(publicKey string) string {
	sum := sha256.Sum256([]byte(publicKey))
	return "SHA256:" + base64.StdEncoding.EncodeToString(sum[:])
}

// CreateServer — see Client.
func (m *MockHetzner) CreateServer(ctx context.Context, opts ServerCreateOpts) (*Server, error) {
	if err := opts.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	if err := m.sleep(ctx); err != nil {
		return nil, err
	}
	if inj := m.takeInjectedError("CreateServer"); inj != nil {
		return nil, inj
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Detect duplicate name — Hetzner rejects names that are in use.
	for _, s := range m.servers {
		if s.Name == opts.Name {
			return nil, fmt.Errorf("%w: server name %q already in use", ErrInvalidInput, opts.Name)
		}
	}

	// Copy labels so caller mutations don't leak into our state.
	labelsCopy := make(map[string]string, len(opts.Labels))
	for k, v := range opts.Labels {
		labelsCopy[k] = v
	}
	if labelsCopy[LabelManagedBy] == "" {
		labelsCopy[LabelManagedBy] = DefaultManagedBy
	}

	id := m.nextID.Add(1)
	now := time.Now().Unix()
	s := &Server{
		ID:          id,
		Name:        opts.Name,
		Status:      ServerStatusInitializing,
		PublicIPv4:  m.nextIP(),
		PrivateIPv4: m.nextPrivateIP(),
		Datacenter:  opts.Region,
		ServerType:  opts.ServerType,
		Image:       opts.Image,
		Labels:      labelsCopy,
		CreatedAt:   now,
	}
	m.servers[id] = s
	return cloneServer(s), nil
}

// GetServer — see Client.
func (m *MockHetzner) GetServer(ctx context.Context, id int64) (*Server, error) {
	if err := m.sleep(ctx); err != nil {
		return nil, err
	}
	if inj := m.takeInjectedError("GetServer"); inj != nil {
		return nil, inj
	}

	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.servers[id]
	if !ok {
		return nil, fmt.Errorf("%w: server id %d", ErrNotFound, id)
	}
	return cloneServer(s), nil
}

// DeleteServer — see Client. Idempotent: returns nil for unknown IDs.
func (m *MockHetzner) DeleteServer(ctx context.Context, id int64) error {
	if err := m.sleep(ctx); err != nil {
		return err
	}
	if inj := m.takeInjectedError("DeleteServer"); inj != nil {
		return inj
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.servers, id)
	return nil
}

// ListServers — see Client. Filter is AND across all provided labels.
func (m *MockHetzner) ListServers(ctx context.Context, labels map[string]string) ([]*Server, error) {
	if err := m.sleep(ctx); err != nil {
		return nil, err
	}
	if inj := m.takeInjectedError("ListServers"); inj != nil {
		return nil, inj
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		if !labelsMatch(s.Labels, labels) {
			continue
		}
		out = append(out, cloneServer(s))
	}
	// Stable order for deterministic tests.
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// CreateSSHKey — see Client.
func (m *MockHetzner) CreateSSHKey(ctx context.Context, opts SSHKeyCreateOpts) (*SSHKey, error) {
	if err := opts.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	if err := m.sleep(ctx); err != nil {
		return nil, err
	}
	if inj := m.takeInjectedError("CreateSSHKey"); inj != nil {
		return nil, inj
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for _, k := range m.sshKeys {
		if k.Name == opts.Name {
			return nil, fmt.Errorf("%w: ssh key name %q already in use", ErrInvalidInput, opts.Name)
		}
	}

	id := m.nextSSHID.Add(1)
	k := &SSHKey{
		ID:          id,
		Name:        opts.Name,
		PublicKey:   opts.PublicKey,
		Fingerprint: fingerprint(opts.PublicKey),
		CreatedAt:   time.Now().Unix(),
	}
	m.sshKeys[id] = k
	return cloneSSHKey(k), nil
}

// GetImage — see Client. Accepts image name or numeric ID string.
func (m *MockHetzner) GetImage(ctx context.Context, name string) (*Image, error) {
	if err := m.sleep(ctx); err != nil {
		return nil, err
	}
	if inj := m.takeInjectedError("GetImage"); inj != nil {
		return nil, inj
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	if id, err := strconv.ParseInt(name, 10, 64); err == nil {
		if img, ok := m.imgByID[id]; ok {
			return cloneImage(img), nil
		}
	}
	// Prefer x86 when caller doesn't specify architecture.
	if img, ok := m.images[imageKey(name, ArchX86)]; ok {
		return cloneImage(img), nil
	}
	if img, ok := m.images[imageKey(name, ArchARM)]; ok {
		return cloneImage(img), nil
	}
	return nil, fmt.Errorf("%w: image %q", ErrNotFound, name)
}

// labelsMatch returns true when want is empty OR every want entry is present
// in have with matching value.
func labelsMatch(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

func cloneServer(s *Server) *Server {
	out := *s
	out.Labels = make(map[string]string, len(s.Labels))
	for k, v := range s.Labels {
		out.Labels[k] = v
	}
	return &out
}

func cloneSSHKey(k *SSHKey) *SSHKey {
	out := *k
	return &out
}

func cloneImage(i *Image) *Image {
	out := *i
	return &out
}

// Compile-time assertion: MockHetzner satisfies Client.
var _ Client = (*MockHetzner)(nil)