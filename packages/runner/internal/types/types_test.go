package types_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pdatahub/pdatahub/runner/internal/types"
)

func TestRegion_Constants(t *testing.T) {
	// Locked 2026-09-08: region codes are part of the public Hetzner API.
	assert.Equal(t, types.Region("fsn1"), types.RegionEU)
	assert.Equal(t, types.Region("ash"), types.RegionUS)
	assert.Equal(t, types.RegionEU, types.DefaultRegion)
}

func TestRegion_String(t *testing.T) {
	assert.Equal(t, "fsn1", types.RegionEU.String())
	assert.Equal(t, "ash", types.RegionUS.String())
	assert.Equal(t, "xxx", types.Region("xxx").String())
}

func TestRegion_IsValid(t *testing.T) {
	cases := []struct {
		region types.Region
		want   bool
	}{
		{types.RegionEU, true},
		{types.RegionUS, true},
		{types.Region(""), false},
		{types.Region("xyz"), false},
		{types.Region("FSN1"), false}, // case sensitive
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, tc.region.IsValid(), "region=%q", tc.region)
	}
}

func TestRegion_HumanName(t *testing.T) {
	assert.Equal(t, "Falkenstein, EU", types.RegionEU.HumanName())
	assert.Equal(t, "Ashburn, US-East", types.RegionUS.HumanName())
	assert.Equal(t, "unknown", types.Region("xyz").HumanName())
}

func TestParseRegion(t *testing.T) {
	cases := []struct {
		in         string
		wantRegion types.Region
		wantErr    bool
	}{
		{"fsn1", types.RegionEU, false},
		{"ash", types.RegionUS, false},
		{"", types.DefaultRegion, false},
		{"xyz", "", true},
		{"FSN1", "", true},
	}
	for _, tc := range cases {
		got, err := types.ParseRegion(tc.in)
		if tc.wantErr {
			assert.Error(t, err, "input=%q", tc.in)
			continue
		}
		require.NoError(t, err, "input=%q", tc.in)
		assert.Equal(t, tc.wantRegion, got, "input=%q", tc.in)
	}
}

func TestAllRegions(t *testing.T) {
	regions := types.AllRegions()
	assert.Len(t, regions, 2)
	assert.Contains(t, regions, types.RegionEU)
	assert.Contains(t, regions, types.RegionUS)
}

func TestPlanTier_IsValid(t *testing.T) {
	assert.True(t, types.PlanTierFree.IsValid())
	assert.True(t, types.PlanTierStarter.IsValid())
	assert.False(t, types.PlanTier("").IsValid())
	assert.False(t, types.PlanTier("premium").IsValid())
}

func TestUserStatus_IsValid(t *testing.T) {
	for _, s := range []types.UserStatus{
		types.UserStatusPending,
		types.UserStatusActive,
		types.UserStatusSuspended,
		types.UserStatusDeleted,
	} {
		assert.True(t, s.IsValid(), "status=%q", s)
	}
	assert.False(t, types.UserStatus("").IsValid())
	assert.False(t, types.UserStatus("banned").IsValid())
}

func TestVMStatus_IsValid(t *testing.T) {
	for _, s := range []types.VMStatus{
		types.VMStatusInitializing,
		types.VMStatusRunning,
		types.VMStatusOffline,
	} {
		assert.True(t, s.IsValid(), "status=%q", s)
	}
	assert.False(t, types.VMStatus("").IsValid())
	assert.False(t, types.VMStatus("deploying").IsValid())
}

func TestUser_Validate(t *testing.T) {
	good := types.User{
		ID:           "u-1",
		Email:        "alice@example.com",
		Region:       types.RegionEU,
		PlanTier:     types.PlanTierFree,
		Status:       types.UserStatusPending,
		MagicDNSName: "u-1.hub.pdatahub.io",
		CreatedAt:    1700000000,
	}
	require.NoError(t, good.Validate())

	cases := []struct {
		name    string
		mutate  func(*types.User)
		errSubs string
	}{
		{"missing id", func(u *types.User) { u.ID = "" }, "ID"},
		{"missing email", func(u *types.User) { u.Email = "" }, "Email"},
		{"bad region", func(u *types.User) { u.Region = types.Region("nope") }, "Region"},
		{"bad plan tier", func(u *types.User) { u.PlanTier = types.PlanTier("vip") }, "PlanTier"},
		{"bad status", func(u *types.User) { u.Status = types.UserStatus("unknown") }, "Status"},
		{"missing magic dns", func(u *types.User) { u.MagicDNSName = "" }, "MagicDNSName"},
		{"zero created_at", func(u *types.User) { u.CreatedAt = 0 }, "CreatedAt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := good
			tc.mutate(&u)
			err := u.Validate()
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.errSubs)
		})
	}
}

func TestVM_Validate(t *testing.T) {
	good := types.VM{
		HetznerID:  12345,
		Name:       "u-1",
		Status:     types.VMStatusInitializing,
		Region:     types.RegionEU,
		SSHKeyID:   7,
		UserID:     "u-1",
		ServerType: "cx22",
		CreatedAt:  1700000000,
		Labels:     map[string]string{"pdatahub-user-id": "u-1"},
	}
	require.NoError(t, good.Validate())

	cases := []struct {
		name    string
		mutate  func(*types.VM)
		errSubs string
	}{
		{"zero hetzner id", func(v *types.VM) { v.HetznerID = 0 }, "HetznerID"},
		{"missing name", func(v *types.VM) { v.Name = "" }, "Name"},
		{"bad status", func(v *types.VM) { v.Status = types.VMStatus("weird") }, "Status"},
		{"bad region", func(v *types.VM) { v.Region = types.Region("xyz") }, "Region"},
		{"zero ssh key id", func(v *types.VM) { v.SSHKeyID = 0 }, "SSHKeyID"},
		{"missing user id", func(v *types.VM) { v.UserID = "" }, "UserID"},
		{"missing server type", func(v *types.VM) { v.ServerType = "" }, "ServerType"},
		{"zero created_at", func(v *types.VM) { v.CreatedAt = 0 }, "CreatedAt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := good
			tc.mutate(&v)
			err := v.Validate()
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.errSubs)
		})
	}
}

func TestHubInstance_Validate(t *testing.T) {
	good := types.HubInstance{
		ID:             "h-1",
		VMID:           12345,
		VMMagicDNSName: "v-1.cloud.pdatahub.io",
		ListenAddr:     types.DefaultHubListenAddr,
		APIToken:       strings.Repeat("a", 2*types.APITokenLen),
		CreatedAt:      1700000000,
	}
	require.NoError(t, good.Validate())

	cases := []struct {
		name    string
		mutate  func(*types.HubInstance)
		errSubs string
	}{
		{"missing id", func(h *types.HubInstance) { h.ID = "" }, "ID"},
		{"zero vmid", func(h *types.HubInstance) { h.VMID = 0 }, "VMID"},
		{"missing magic dns", func(h *types.HubInstance) { h.VMMagicDNSName = "" }, "VMMagicDNSName"},
		{"missing listen addr", func(h *types.HubInstance) { h.ListenAddr = "" }, "ListenAddr"},
		{"short api token", func(h *types.HubInstance) { h.APIToken = "abc" }, "APIToken"},
		{"non-hex api token", func(h *types.HubInstance) { h.APIToken = strings.Repeat("z", 2*types.APITokenLen) }, "hex"},
		{"zero created_at", func(h *types.HubInstance) { h.CreatedAt = 0 }, "CreatedAt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := good
			tc.mutate(&h)
			err := h.Validate()
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.errSubs)
		})
	}
}

func TestNewAPIToken(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		token, err := types.NewAPIToken(func(n int) ([]byte, error) {
			buf := make([]byte, n)
			for i := range buf {
				buf[i] = byte(i) // deterministic but non-zero
			}
			return buf, nil
		})
		require.NoError(t, err)
		assert.Len(t, token, 2*types.APITokenLen)
		// Verify the value matches what we'd encode from the seed.
		assert.Equal(t, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", token)
	})

	t.Run("nil rand func", func(t *testing.T) {
		_, err := types.NewAPIToken(nil)
		require.Error(t, err)
	})

	t.Run("rand func error", func(t *testing.T) {
		_, err := types.NewAPIToken(func(int) ([]byte, error) {
			return nil, assert.AnError
		})
		require.Error(t, err)
		assert.ErrorIs(t, err, assert.AnError)
	})
}