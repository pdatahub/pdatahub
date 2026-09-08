package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRun_DryRun_PrintsBannerAndExits(t *testing.T) {
	var out, errOut bytes.Buffer
	require.NoError(t, Run(&out, &errOut, "--dry-run"))
	assert.Contains(t, out.String(), "pdatahub-runner v"+Version)
	assert.Contains(t, out.String(), Phase)
	assert.Contains(t, out.String(), "Would start runner on :8081")
	assert.Contains(t, out.String(), "Phase 1B wires real Hetzner client")
	assert.Empty(t, errOut.String())
}

func TestRun_CustomPort(t *testing.T) {
	var out bytes.Buffer
	require.NoError(t, Run(&out, nil, "--dry-run", "--port", "9090"))
	assert.Contains(t, out.String(), "Would start runner on :9090")
}

func TestRun_VerbosePrintsFlags(t *testing.T) {
	var out bytes.Buffer
	require.NoError(t, Run(&out, nil, "--dry-run", "--verbose", "--port", "1234"))
	assert.Contains(t, out.String(), "port    : 1234")
	assert.Contains(t, out.String(), "dry-run : true")
}

func TestRun_NonDryRun_Panics(t *testing.T) {
	var out bytes.Buffer
	assert.PanicsWithValue(t, "Phase 1B: not implemented", func() {
		_ = Run(&out, nil, "--dry-run=false")
	})
}

func TestRun_BadFlag_ReturnsError(t *testing.T) {
	var out, errOut bytes.Buffer
	err := Run(&out, &errOut, "--unknown-flag")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse flags")
}

func TestVersion_IsStable(t *testing.T) {
	// Locked for Phase 1A. Bumping it requires updating README + roadmap.
	assert.Equal(t, "0.1.0-alpha", Version)
	assert.True(t, strings.HasPrefix(Phase, "Phase 1A"), "Phase constant must mention the phase")
}