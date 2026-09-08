// Package hetzner defines the Hetzner Cloud control-plane interface used by
// the pdatahub-runner, plus the SDK-side value types it returns.
//
// Phase 1A: only the Client interface and the data types are stable API.
// A real implementation backed by github.com/hetznercloud/hcloud-go lands in
// Phase 1B (after the user provides a Hetzner API token).
//
// All callers should depend on the Client interface, not a concrete type, so
// tests can swap in the in-memory MockHetzner (see mock.go).
package hetzner

import (
	"context"
	"errors"
	"fmt"
)

// ReservedLabelPrefix is the prefix all runner-managed labels use. Phase 1B
// may extend with version, deployment-id, etc.
const ReservedLabelPrefix = "pdatahub-"

// Managed-by label key (constant value).
const (
	LabelManagedBy   = ReservedLabelPrefix + "managed-by"
	LabelUserID      = ReservedLabelPrefix + "user-id"
	LabelHubInstance = ReservedLabelPrefix + "hub-instance-id"

	// DefaultManagedBy is the value of LabelManagedBy on runner-provisioned VMs.
	DefaultManagedBy = "runner"
)

// ServerStatus is the lifecycle state of a Hetzner cloud server, restricted to
// the values we care about. Hetzner exposes additional transient states
// (starting, stopping, migrating) that we collapse to "initializing".
type ServerStatus string

const (
	// ServerStatusInitializing — VM is booting, cloud-init is running, SSH not yet ready.
	ServerStatusInitializing ServerStatus = "initializing"
	// ServerStatusRunning — VM is up and reachable.
	ServerStatusRunning ServerStatus = "running"
	// ServerStatusOffline — VM is stopped or unreachable.
	ServerStatusOffline ServerStatus = "offline"
)

// IsValid reports whether the ServerStatus is one of the canonical values.
func (s ServerStatus) IsValid() bool {
	switch s {
	case ServerStatusInitializing, ServerStatusRunning, ServerStatusOffline:
		return true
	default:
		return false
	}
}

// Architecture describes the CPU architecture of an image.
type Architecture string

const (
	ArchX86 Architecture = "x86"
	ArchARM Architecture = "arm"
)

// IsValid reports whether the Architecture is one of the canonical values.
func (a Architecture) IsValid() bool {
	switch a {
	case ArchX86, ArchARM:
		return true
	default:
		return false
	}
}

// Image is a Hetzner cloud server image (snapshot of an OS install).
type Image struct {
	ID           int64
	Name         string
	Architecture Architecture
}

// SSHKey is a public key registered with Hetzner for use when provisioning
// servers. The runner uploads one SSH key per VM (ed25519, generated locally).
type SSHKey struct {
	ID          int64
	Name        string
	Fingerprint string // SHA256:<base64>, matches `ssh-keygen -lf`
	PublicKey   string // authorized_keys line, kept here for debugging
	CreatedAt   int64
}

// Server is a Hetzner cloud server as returned by the API.
//
// Region is stored as the canonical Hetzner datacenter location string
// ("fsn1", "ash", etc.).
type Server struct {
	ID           int64
	Name         string
	Status       ServerStatus
	PublicIPv4   string
	PrivateIPv4  string
	Datacenter   string
	ServerType   string
	Image        string // image name or ID
	Labels       map[string]string
	CreatedAt    int64
}

// ServerCreateOpts is the input to Client.CreateServer.
//
// CloudInit is the cloud-config YAML to inject. Hetzner passes this through to
// cloud-init at first boot.
type ServerCreateOpts struct {
	Name       string
	ServerType string // e.g. "cx22"
	Image      string // image name or numeric ID; "ubuntu-24.04" in Phase 1A
	Region     string // e.g. "fsn1"
	SSHKeys    []int64
	CloudInit  string
	Labels     map[string]string
}

// Validate returns an error if the options are missing required fields.
//
// Performed by both the real client (defense in depth) and the mock (so tests
// catch regressions before they hit production).
func (o *ServerCreateOpts) Validate() error {
	if o.Name == "" {
		return errors.New("server name is required")
	}
	if o.ServerType == "" {
		return errors.New("server type is required")
	}
	if o.Image == "" {
		return errors.New("server image is required")
	}
	if o.Region == "" {
		return errors.New("server region is required")
	}
	return nil
}

// SSHKeyCreateOpts is the input to Client.CreateSSHKey.
type SSHKeyCreateOpts struct {
	Name      string
	PublicKey string
}

// Validate returns an error if the options are missing required fields.
func (o *SSHKeyCreateOpts) Validate() error {
	if o.Name == "" {
		return errors.New("ssh key name is required")
	}
	if o.PublicKey == "" {
		return errors.New("ssh key public key is required")
	}
	return nil
}

// ErrNotFound is returned by Get* / Delete* when the resource does not exist.
// Callers can use errors.Is to detect this case.
var ErrNotFound = errors.New("hetzner: resource not found")

// ErrInvalidInput is returned when input validation fails inside the client
// (e.g. empty name). Wraps the underlying validation error.
var ErrInvalidInput = errors.New("hetzner: invalid input")

// Client is the runner's view of the Hetzner Cloud control plane.
//
// Methods take a context so the runner can cancel long-running operations
// (e.g. polling server creation) on shutdown. Errors are wrapped with op
// context so callers can log them productively.
type Client interface {
	// CreateServer creates a new cloud server. Returns the server record with
	// the assigned ID and initial status (typically ServerStatusInitializing).
	CreateServer(ctx context.Context, opts ServerCreateOpts) (*Server, error)

	// GetServer returns the current state of a server by ID.
	// Returns ErrNotFound if the server does not exist.
	GetServer(ctx context.Context, id int64) (*Server, error)

	// DeleteServer removes a server. Idempotent: returns nil if the server is
	// already gone (so retrying after a partial failure is safe).
	DeleteServer(ctx context.Context, id int64) error

	// ListServers returns servers matching ALL provided label key=value pairs.
	// A nil or empty labels map returns every server (paginated internally).
	ListServers(ctx context.Context, labels map[string]string) ([]*Server, error)

	// CreateSSHKey registers a public key with Hetzner.
	CreateSSHKey(ctx context.Context, opts SSHKeyCreateOpts) (*SSHKey, error)

	// GetImage resolves an image name (or numeric ID string) to an Image.
	// Returns ErrNotFound if the image does not exist.
	GetImage(ctx context.Context, name string) (*Image, error)
}

// AsError formats an error with op context for logging. Use:
//
//	return hetzner.AsError("CreateServer", err)
func AsError(op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("hetzner.%s: %w", op, err)
}