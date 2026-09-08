package types

import (
	"errors"
	"fmt"
)

// VMStatus mirrors Hetzner server status values we care about. We keep this
// independent of the Hetzner enum so internal types don't depend on the SDK.
//
// Phase 1A: 1:1 mapping with Hetzner ServerStatus; Phase 1B may add runner-
// specific statuses (e.g. "deploying", "degraded") that the runner assigns.
type VMStatus string

const (
	// VMStatusInitializing — VM is booting, cloud-init running.
	VMStatusInitializing VMStatus = "initializing"
	// VMStatusRunning — VM is up and reachable; hub-core is the deployment target.
	VMStatusRunning VMStatus = "running"
	// VMStatusOffline — VM is stopped or unreachable.
	VMStatusOffline VMStatus = "offline"
)

// IsValid reports whether the VMStatus is one of the canonical values.
func (s VMStatus) IsValid() bool {
	switch s {
	case VMStatusInitializing, VMStatusRunning, VMStatusOffline:
		return true
	default:
		return false
	}
}

// VM is the control-plane mirror of a Hetzner cloud server.
//
// One VM hosts exactly one HubInstance (one user's hub-core).
type VM struct {
	// HetznerID is the server ID assigned by the cloud provider.
	HetznerID int64
	// Name is the human-readable Hetzner server name (e.g. "u-abc123").
	Name string
	// PublicIPv4 is the public IPv4 address (MagicDNS resolves to this via Tailscale).
	PublicIPv4 string
	// PrivateIPv4 is the Hetzner private network IPv4 (used for control-plane traffic).
	PrivateIPv4 string
	// Status is the current VM status.
	Status VMStatus
	// Region is the VM's datacenter region.
	Region Region
	// SSHKeyID is the Hetzner SSH key ID used to SSH into this VM.
	SSHKeyID int64
	// UserID is the owning user.
	UserID string
	// ServerType is the Hetzner server type (e.g. "cx22").
	ServerType string
	// Labels are Hetzner labels used by ListServers filtering.
	Labels map[string]string
	// CreatedAt is the unix timestamp (seconds) the VM was created.
	CreatedAt int64
}

// Validate returns an error if the VM record is missing required fields.
//
// HetznerID > 0 is required because every persisted VM must have been
// successfully created on Hetzner. Pre-create drafts use a different type.
func (v *VM) Validate() error {
	if v.HetznerID <= 0 {
		return errors.New("vm.HetznerID must be positive")
	}
	if v.Name == "" {
		return errors.New("vm.Name is required")
	}
	if !v.Status.IsValid() {
		return fmt.Errorf("vm.Status is invalid: %q", v.Status)
	}
	if !v.Region.IsValid() {
		return fmt.Errorf("vm.Region is invalid: %q", v.Region)
	}
	if v.SSHKeyID <= 0 {
		return errors.New("vm.SSHKeyID must be positive")
	}
	if v.UserID == "" {
		return errors.New("vm.UserID is required")
	}
	if v.ServerType == "" {
		return errors.New("vm.ServerType is required")
	}
	if v.CreatedAt <= 0 {
		return errors.New("vm.CreatedAt must be positive")
	}
	return nil
}