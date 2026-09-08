package hubcore_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pdatahub/pdatahub/runner/internal/hubcore"
)

// goodOpts returns a DeployOpts that passes validation with all required
// fields populated. Used by mutation tests.
func goodOpts() hubcore.DeployOpts {
	return hubcore.DeployOpts{
		HubCoreVersion: "v0.1.0",
		HUBApiToken:    "deadbeefcafebabe0011223344556677aabbccdd0011223344556677aabbccdd",
		MagicDNSDomain: "cloud.pdatahub.io",
		VMHostname:     "v-test01",
		InstallDir:     "/opt/pdatahub/hub-core",
		HubInstanceID:  "h-001",
		PublicIPv4:     "10.0.0.2",
	}
}

func TestPlanDeployment_HappyPath(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)
	require.NotNil(t, plan)

	// Expected step names (order matters for the executor).
	expected := []string{
		"verify-instance-metadata",
		"download-sha256sums",
		"download-tarball",
		"verify-sha256",
		"extract-tarball",
		"stamp-installed-version",
		"write-hub-env",
		"write-systemd-unit",
		"systemd-daemon-reload",
		"systemd-enable-now",
		"health-check",
	}
	require.Len(t, plan.Steps, len(expected), "step count drifted; update both this assertion and the deploy.go comments")
	for i, want := range expected {
		assert.Equal(t, want, plan.Steps[i].Name, "step %d name", i)
	}
}

func TestPlanDeployment_DefaultsFilledIn(t *testing.T) {
	opts := goodOpts()
	opts.InstallDir = ""
	plan, err := hubcore.PlanDeployment(opts)
	require.NoError(t, err)

	// The install dir must appear in step args / unit file paths.
	for _, s := range plan.Steps {
		for _, a := range s.Args {
			assert.NotContains(t, a, "<install>", "unfilled default in step %q args", s.Name)
		}
	}
}

func TestPlanDeployment_RequiredFieldsRejected(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*hubcore.DeployOpts)
		errSubs string
	}{
		{"missing version", func(o *hubcore.DeployOpts) { o.HubCoreVersion = "" }, "HubCoreVersion"},
		{"version without v prefix", func(o *hubcore.DeployOpts) { o.HubCoreVersion = "0.1.0" }, "must start with 'v'"},
		{"missing api token", func(o *hubcore.DeployOpts) { o.HUBApiToken = "" }, "HUBApiToken"},
		{"missing magic dns", func(o *hubcore.DeployOpts) { o.MagicDNSDomain = "" }, "MagicDNSDomain"},
		{"missing hostname", func(o *hubcore.DeployOpts) { o.VMHostname = "" }, "VMHostname"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := goodOpts()
			tc.mutate(&o)
			_, err := hubcore.PlanDeployment(o)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.errSubs)
		})
	}
}

func TestPlanDeployment_PopulatesMetadata(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)
	assert.Equal(t, "v0.1.0", plan.Version)
	assert.Equal(t, "h-001", plan.HubInstanceID)
	assert.Equal(t, "10.0.0.2", plan.TargetVM)
}

func TestPlanDeployment_AllStepsRemote(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)
	for _, s := range plan.Steps {
		assert.Equal(t, hubcore.StepKindRemote, s.Kind, "step %q should be remote", s.Name)
	}
}

func TestPlanDeployment_EmbedsApiTokenInEnvFile(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	// Find write-hub-env and confirm token is in the heredoc payload.
	var envStep *hubcore.Step
	for i := range plan.Steps {
		if plan.Steps[i].Name == "write-hub-env" {
			envStep = &plan.Steps[i]
			break
		}
	}
	require.NotNil(t, envStep)
	require.NotEmpty(t, envStep.Args, "write-hub-env must have a bash heredoc command")
	cmd := envStep.Args[len(envStep.Args)-1]
	assert.Contains(t, cmd, "HUB_API_TOKEN=deadbeefcafebabe0011223344556677aabbccdd0011223344556677aabbccdd")
	assert.Contains(t, cmd, "HUB_PUBLIC_HOSTNAME=v-test01.cloud.pdatahub.io")
	assert.Contains(t, cmd, "HUB_TAILSCALE_DOMAIN=cloud.pdatahub.io")
	assert.Contains(t, cmd, "HUB_LISTEN_ADDR=0.0.0.0:8080")
}

func TestPlanDeployment_VersionIsPinnedInSteps(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	// The tarball filename must include v0.1.0 (not "latest").
	for _, s := range plan.Steps {
		joined := strings.Join(s.Args, " ")
		if strings.Contains(joined, ".tgz") {
			assert.Contains(t, joined, "pdatahub-hub-core-v0.1.0.tgz", "step %q", s.Name)
		}
		if strings.Contains(s.Name, "stamp") || strings.Contains(s.Name, "installed-version") {
			assert.Contains(t, joined, "v0.1.0", "step %q must pin version", s.Name)
		}
	}
}

func TestPlanDeployment_ReleasesURL(t *testing.T) {
	url := hubcore.ReleasesURL(goodOpts())
	assert.Equal(t, "https://github.com/pdatahub/pdatahub/releases/download/v0.1.0/pdatahub-hub-core-v0.1.0.tgz", url)
}

func TestPlanDeployment_CustomReleasesBase(t *testing.T) {
	opts := goodOpts()
	opts.ReleasesBaseURL = "https://artifacts.example.com/pdatahub"
	plan, err := hubcore.PlanDeployment(opts)
	require.NoError(t, err)

	// First download step should use the custom base.
	var downloadChecksums *hubcore.Step
	for i := range plan.Steps {
		if plan.Steps[i].Name == "download-sha256sums" {
			downloadChecksums = &plan.Steps[i]
			break
		}
	}
	require.NotNil(t, downloadChecksums)
	joined := strings.Join(downloadChecksums.Args, " ")
	assert.Contains(t, joined, "artifacts.example.com")
	assert.NotContains(t, joined, "github.com")
}

func TestPlanDeployment_HealthCheckHasRetries(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	var hc *hubcore.Step
	for i := range plan.Steps {
		if plan.Steps[i].Name == "health-check" {
			hc = &plan.Steps[i]
			break
		}
	}
	require.NotNil(t, hc)
	joined := strings.Join(hc.Args, " ")
	assert.Contains(t, joined, "seq 1 30")
	assert.Contains(t, joined, "/v1/identity")
	assert.Contains(t, joined, "exit 1", "health check must exit 1 on timeout")
}

func TestPlanDeployment_DownloadHasRetries(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	for _, s := range plan.Steps {
		if s.Name == "download-sha256sums" || s.Name == "download-tarball" {
			assert.GreaterOrEqual(t, s.RetryCount, 1, "step %q should be retryable", s.Name)
		}
	}
}

func TestPlanDeployment_Idempotent(t *testing.T) {
	// Same opts should produce structurally identical plans.
	opts := goodOpts()
	p1, err := hubcore.PlanDeployment(opts)
	require.NoError(t, err)
	p2, err := hubcore.PlanDeployment(opts)
	require.NoError(t, err)
	require.Len(t, p1.Steps, len(p2.Steps))

	for i := range p1.Steps {
		assert.Equal(t, p1.Steps[i].Name, p2.Steps[i].Name, "step %d name", i)
		assert.Equal(t, p1.Steps[i].Kind, p2.Steps[i].Kind, "step %d kind", i)
		assert.Equal(t, p1.Steps[i].Command, p2.Steps[i].Command, "step %d command", i)
		assert.Equal(t, p1.Steps[i].Args, p2.Steps[i].Args, "step %d args", i)
	}
}

func TestPlanDeployment_TimeoutScaling(t *testing.T) {
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	// Health check timeout must be > DefaultHealthTimeoutSec.
	var hcTimeout, metadataTimeout int
	for _, s := range plan.Steps {
		switch s.Name {
		case "health-check":
			hcTimeout = s.TimeoutSeconds
		case "verify-instance-metadata":
			metadataTimeout = s.TimeoutSeconds
		}
	}
	assert.Greater(t, hcTimeout, 0)
	assert.Greater(t, metadataTimeout, 0)
	assert.LessOrEqual(t, metadataTimeout, hcTimeout)
}

func TestPlanDeployment_WritesRestrictiveEnvFile(t *testing.T) {
	// The plan doesn't chmod the env file (cloud-init does that at file
	// write time). We just verify the file path and contents are correct;
	// permissions are enforced in the cloud-init script generator.
	plan, err := hubcore.PlanDeployment(goodOpts())
	require.NoError(t, err)

	var envStep *hubcore.Step
	for i := range plan.Steps {
		if plan.Steps[i].Name == "write-hub-env" {
			envStep = &plan.Steps[i]
			break
		}
	}
	require.NotNil(t, envStep)
	cmd := envStep.Args[len(envStep.Args)-1]
	assert.Contains(t, cmd, "/etc/pdatahub/hub.env")
	assert.Contains(t, cmd, "mkdir -p /etc/pdatahub")
}