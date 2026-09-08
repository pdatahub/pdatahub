// Package types defines the domain entities shared across the pdatahub-runner
// control plane: users, virtual machines, hub instances, and the region enum.
//
// Phase 1A: pure data types with no I/O. Phase 1B wires these into the runner
// service layer that persists them in a control-plane database.
package types

import (
	"errors"
	"fmt"
)

// PlanTier represents a user's subscription plan. Cloud v3 ships two tiers.
type PlanTier string

const (
	// PlanTierFree allows a single plugin and limited daily calls (Phase 3).
	PlanTierFree PlanTier = "free"
	// PlanTierStarter is the paid tier ($5/mo).
	PlanTierStarter PlanTier = "starter"
)

// IsValid reports whether the PlanTier is one of the canonical values.
func (p PlanTier) IsValid() bool {
	switch p {
	case PlanTierFree, PlanTierStarter:
		return true
	default:
		return false
	}
}

// UserStatus is the lifecycle state of a cloud user record.
type UserStatus string

const (
	// UserStatusPending — created in DB, awaiting VM provisioning.
	UserStatusPending UserStatus = "pending"
	// UserStatusActive — VM provisioned and reachable.
	UserStatusActive UserStatus = "active"
	// UserStatusSuspended — billing failed or admin action; VM is powered off.
	UserStatusSuspended UserStatus = "suspended"
	// UserStatusDeleted — soft-deleted; VM destroyed.
	UserStatusDeleted UserStatus = "deleted"
)

// IsValid reports whether the UserStatus is one of the canonical values.
func (s UserStatus) IsValid() bool {
	switch s {
	case UserStatusPending, UserStatusActive, UserStatusSuspended, UserStatusDeleted:
		return true
	default:
		return false
	}
}

// User is the top-level tenant record.
//
// One User owns exactly one VM (Phase 1A assumption; multi-VM is out of scope).
type User struct {
	// ID is a stable UUID used as the foreign key from VM, HubInstance, etc.
	ID string
	// Email is the user's verified email (from Google OAuth in Phase 2).
	Email string
	// Region is the geographic region of the user's VM.
	Region Region
	// PlanTier is the user's subscription plan.
	PlanTier PlanTier
	// Status is the user's lifecycle state.
	Status UserStatus
	// MagicDNSName is the user's stable hostname on hub.pdatahub.io,
	// e.g. "u-abc123.hub.pdatahub.io". Used for OAuth callback and approval URLs.
	MagicDNSName string
	// CreatedAt is the unix timestamp (seconds) the user was created.
	CreatedAt int64
}

// Validate returns an error if the User record is missing required fields.
func (u *User) Validate() error {
	if u.ID == "" {
		return errors.New("user.ID is required")
	}
	if u.Email == "" {
		return errors.New("user.Email is required")
	}
	if !u.Region.IsValid() {
		return fmt.Errorf("user.Region is invalid: %q", u.Region)
	}
	if !u.PlanTier.IsValid() {
		return fmt.Errorf("user.PlanTier is invalid: %q", u.PlanTier)
	}
	if !u.Status.IsValid() {
		return fmt.Errorf("user.Status is invalid: %q", u.Status)
	}
	if u.MagicDNSName == "" {
		return errors.New("user.MagicDNSName is required")
	}
	if u.CreatedAt <= 0 {
		return errors.New("user.CreatedAt must be positive")
	}
	return nil
}