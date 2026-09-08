package types

import (
	"encoding/hex"
	"errors"
	"fmt"
)

// DefaultHubListenAddr is the default hub-core bind address. Matches the
// hub-core default in packages/hub-core/src/config.ts.
const DefaultHubListenAddr = "0.0.0.0:8080"

// DefaultMagicDNSDomain is the Tailscale tailnet where cloud VMs register.
// Locked 2026-09-08.
const DefaultMagicDNSDomain = "cloud.pdatahub.io"

// APITokenLen is the byte length of a hub-core API token. The token is rendered
// as hex, so the string length is 2*APITokenLen.
const APITokenLen = 32

// HubInstance represents a deployed hub-core running on a VM.
//
// One HubInstance is owned by exactly one VM (and transitively by one User).
type HubInstance struct {
	// ID is the runner's internal UUID for this hub instance.
	ID string
	// VMID is the Hetzner server ID hosting this instance.
	VMID int64
	// VMMagicDNSName is the hub-core's Tailscale MagicDNS name, e.g.
	// "v-xyz789.cloud.pdatahub.io". Used by the mcp-server and Android app
	// to reach hub-core over the Tailscale mesh.
	VMMagicDNSName string
	// ListenAddr is the hub-core bind address inside the VM.
	ListenAddr string
	// APIToken is the bearer token clients use to authenticate to hub-core.
	// 32 bytes, hex-encoded (64 chars).
	APIToken string
	// OAuthClientCredentialsRef is a pointer to where per-plugin OAuth client
	// credentials live (Phase 4). In Phase 1A we leave this nil and use the
	// runner-side shared secret env vault.
	OAuthClientCredentialsRef string
	// CreatedAt is the unix timestamp (seconds) the instance was provisioned.
	CreatedAt int64
}

// NewAPIToken returns a random 32-byte hex string. Phase 1A callers pass the
// result in directly; Phase 1B reads from crypto/rand at deploy time.
//
// Provided as a helper for tests and the cloud-init script generator.
func NewAPIToken(randBytes func(int) ([]byte, error)) (string, error) {
	if randBytes == nil {
		return "", errors.New("randBytes is nil")
	}
	b, err := randBytes(APITokenLen)
	if err != nil {
		return "", fmt.Errorf("generate api token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// Validate returns an error if the HubInstance record is missing required fields.
func (h *HubInstance) Validate() error {
	if h.ID == "" {
		return errors.New("hub.ID is required")
	}
	if h.VMID <= 0 {
		return errors.New("hub.VMID must be positive")
	}
	if h.VMMagicDNSName == "" {
		return errors.New("hub.VMMagicDNSName is required")
	}
	if h.ListenAddr == "" {
		return errors.New("hub.ListenAddr is required")
	}
	// APIToken must be hex-encoded 32 bytes (64 chars).
	if len(h.APIToken) != 2*APITokenLen {
		return fmt.Errorf("hub.APIToken must be %d hex chars, got %d", 2*APITokenLen, len(h.APIToken))
	}
	if _, err := hex.DecodeString(h.APIToken); err != nil {
		return fmt.Errorf("hub.APIToken is not valid hex: %w", err)
	}
	if h.CreatedAt <= 0 {
		return errors.New("hub.CreatedAt must be positive")
	}
	return nil
}