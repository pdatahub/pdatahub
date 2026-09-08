package types

import (
	"fmt"
)

// Region represents the geographic region where a user's VM lives.
//
// Phase 1A: enum is closed and exhaustive. New regions require a code change.
type Region string

const (
	// RegionEU is Hetzner Falkenstein, Germany (DC name "fsn1").
	RegionEU Region = "fsn1"
	// RegionUS is Hetzner Ashburn, Virginia, US-East (DC name "ash").
	RegionUS Region = "ash"

	// DefaultRegion is the region assigned to new users that do not opt in
	// to a different region. EU only is locked for Phase 1 launch (2026-09-08).
	DefaultRegion Region = RegionEU
)

// String returns the region code (e.g. "fsn1"). Implements fmt.Stringer.
func (r Region) String() string {
	return string(r)
}

// IsValid reports whether the region code is one of the canonical values.
func (r Region) IsValid() bool {
	switch r {
	case RegionEU, RegionUS:
		return true
	default:
		return false
	}
}

// HumanName returns a human-readable location for logs and UI.
//
// Phase 1A: hardcoded map; expand when adding new regions.
func (r Region) HumanName() string {
	switch r {
	case RegionEU:
		return "Falkenstein, EU"
	case RegionUS:
		return "Ashburn, US-East"
	default:
		return "unknown"
	}
}

// ParseRegion parses a string into a Region, returning an error if invalid.
//
// Empty input is treated as DefaultRegion for ergonomic defaults.
func ParseRegion(s string) (Region, error) {
	if s == "" {
		return DefaultRegion, nil
	}
	r := Region(s)
	if !r.IsValid() {
		return "", fmt.Errorf("invalid region %q (valid: %q, %q)", s, RegionEU, RegionUS)
	}
	return r, nil
}

// AllRegions returns the exhaustive list of valid regions. Used for validation
// loops and test fixtures.
func AllRegions() []Region {
	return []Region{RegionEU, RegionUS}
}