package cloudinit_test

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pdatahub/pdatahub/runner/internal/cloudinit"
)

// goldenOpts returns a fixed Options used to generate the golden file.
// Changes to this struct require regenerating testdata/cloudinit.golden
// (pass -update to go test).
func goldenOpts() cloudinit.Options {
	return cloudinit.Options{
		Hostname:         "v-test01",
		TailscaleAuthKey: "tskey-fake-GOLDEN-001",
		HUBApiToken:      "deadbeefcafebabe0011223344556677aabbccdd0011223344556677aabbccdd",
		MagicDNSDomain:   "cloud.pdatahub.io",
		HubCoreVersion:   "v0.1.0",
		AdminEmail:       "golden@pdatahub.io",
		// InstallDir intentionally omitted to test the default.
	}
}

var update = flag.Bool("update", false, "update golden files in testdata/")

func TestGenerate_GoldenFile(t *testing.T) {
	got := cloudinit.Generate(goldenOpts())
	goldenPath := filepath.Join("testdata", "cloudinit.golden")

	if *update {
		require.NoError(t, os.WriteFile(goldenPath, []byte(got), 0o644))
		t.Log("golden file updated; rerun without -update to verify")
		return
	}

	want, err := os.ReadFile(goldenPath)
	require.NoError(t, err)
	assert.Equal(t, string(want), got, "cloud-init output drifted from golden; rerun with -update if intentional")
}

func TestGenerate_IdempotentForFixedOpts(t *testing.T) {
	// Calling Generate twice with identical opts must produce byte-identical output.
	opts := goldenOpts()
	first := cloudinit.Generate(opts)
	second := cloudinit.Generate(opts)
	assert.Equal(t, first, second)
}

func TestGenerate_StartsWithCloudConfigHeader(t *testing.T) {
	out := cloudinit.Generate(goldenOpts())
	lines := strings.SplitN(out, "\n", 2)
	require.NotEmpty(t, lines)
	assert.Equal(t, "#cloud-config", strings.TrimRight(lines[0], "\r"))
}

func TestGenerate_ContainsRequiredSections(t *testing.T) {
	out := cloudinit.Generate(goldenOpts())
	required := []string{
		"package_update: true",
		"write_files:",
		"/etc/systemd/system/pdatahub-hub.service",
		"/etc/pdatahub/hub.env",
		"runcmd:",
		"set -euo pipefail",
		"tailscale up",
		"systemctl daemon-reload",
		"systemctl enable pdatahub-hub.service",
		"pdatahub-hub-core",     // install dir prefix
		"v0.1.0",                // hub-core version pinned
		"cloud.pdatahub.io",     // tailnet
	}
	for _, r := range required {
		assert.Contains(t, out, r, "missing required snippet %q", r)
	}
}

func TestGenerate_EmbedsProvidedCredentials(t *testing.T) {
	opts := cloudinit.Options{
		Hostname:         "v-xyz789",
		TailscaleAuthKey: "tskey-real-XYZ-999",
		HUBApiToken:      "feedface0011223344556677889900aabbccddeeff0011223344556677889900",
		MagicDNSDomain:   "cloud.pdatahub.io",
		HubCoreVersion:   "v0.2.0",
		AdminEmail:       "alice@example.com",
	}
	out := cloudinit.Generate(opts)
	assert.Contains(t, out, "v-xyz789")
	assert.Contains(t, out, "tskey-real-XYZ-999")
	assert.Contains(t, out, "feedface0011223344556677889900aabbccddeeff0011223344556677889900")
	assert.Contains(t, out, "alice@example.com")
	assert.Contains(t, out, "v0.2.0")
}

func TestGenerate_AppliesDefaultMagicDNSDomain(t *testing.T) {
	opts := cloudinit.Options{
		Hostname:         "v-default",
		TailscaleAuthKey: "k",
		HUBApiToken:      strings.Repeat("a", 64),
		HubCoreVersion:   "v0.1.0",
		AdminEmail:       "x@y",
	}
	out := cloudinit.Generate(opts)
	assert.Contains(t, out, "HUB_TAILSCALE_DOMAIN=cloud.pdatahub.io")
	assert.Contains(t, out, "v-default.cloud.pdatahub.io")
}

func TestGenerate_AppliesDefaultInstallDir(t *testing.T) {
	opts := cloudinit.Options{
		Hostname:         "v-defaultdir",
		TailscaleAuthKey: "k",
		HUBApiToken:      strings.Repeat("a", 64),
		HubCoreVersion:   "v0.1.0",
		AdminEmail:       "x@y",
	}
	out := cloudinit.Generate(opts)
	assert.Contains(t, out, "/opt/pdatahub/hub-core")
}

func TestGenerate_RespectsCustomMagicDNSDomain(t *testing.T) {
	opts := cloudinit.Options{
		Hostname:         "v-staging",
		TailscaleAuthKey: "k",
		HUBApiToken:      strings.Repeat("a", 64),
		MagicDNSDomain:   "staging.cloud.pdatahub.io",
		HubCoreVersion:   "v0.1.0",
		AdminEmail:       "x@y",
	}
	out := cloudinit.Generate(opts)
	// The custom tailnet shows up in HUB_TAILSCALE_DOMAIN and the public hostname.
	assert.Contains(t, out, "HUB_TAILSCALE_DOMAIN=staging.cloud.pdatahub.io")
	assert.Contains(t, out, "HUB_PUBLIC_HOSTNAME=v-staging.staging.cloud.pdatahub.io")
	// The header comment also references it.
	assert.Contains(t, out, "# Tailnet:     staging.cloud.pdatahub.io")
}

func TestGenerate_PermissionsAreRestrictive(t *testing.T) {
	out := cloudinit.Generate(goldenOpts())
	assert.Contains(t, out, "permissions: '0600'", "hub.env must be root-only (contains API token)")
	assert.Contains(t, out, "permissions: '0644'", "service unit is world-readable")
}

func TestGenerate_IncludesIdempotencyGuards(t *testing.T) {
	out := cloudinit.Generate(goldenOpts())
	// Guards we expect to see:
	//   1. tailscale installed check (skip if present)
	//   2. tailscale already running check (skip `tailscale up`)
	//   3. hub-core .installed-version check (skip reinstall)
	guards := []string{
		"if ! command -v tailscale",
		"tailscale status --json",
		"if [ ! -f /opt/pdatahub/hub-core/.installed-version ]",
		".installed-version",
	}
	for _, g := range guards {
		assert.Contains(t, out, g, "missing idempotency guard %q", g)
	}
}

func TestGenerate_HealthCheckLoop(t *testing.T) {
	out := cloudinit.Generate(goldenOpts())
	assert.Contains(t, out, "seq 1 30")
	assert.Contains(t, out, "/v1/identity")
	assert.Contains(t, out, "journalctl -u pdatahub-hub.service")
}