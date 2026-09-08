// Package hubcore plans the deployment of hub-core onto a freshly-provisioned
// Hetzner VM.
//
// Phase 1A: PLAN ONLY. PlanDeployment returns a DeployPlan describing the
// ordered steps required to install hub-core; it does NOT execute them.
//
// Phase 1B will introduce an executor that SSHes into the VM and runs each
// Step in order, capturing stdout/stderr for logging. The plan/execute split
// lets us:
//
//   - Diff two plans to detect unexpected changes before deploying
//   - Render a plan as a shell script for human review / disaster recovery
//   - Unit-test the plan logic without SSH/network I/O
package hubcore

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// StepKind classifies a Step's intent. The executor uses this to decide how
// to run the step (local command vs scp, fail-fast vs best-effort, etc.).
type StepKind string

const (
	// StepKindLocal runs on the runner host (rare in Phase 1A).
	StepKindLocal StepKind = "local"
	// StepKindRemote runs on the target VM via SSH.
	StepKindRemote StepKind = "remote"
	// StepKindUpload copies a file from runner → VM (scp / rsync / sftp).
	StepKindUpload StepKind = "upload"
	// StepKindGroup is a logical grouping; the executor expands it to
	// multiple sub-steps (used for "verify" sections that retry).
	StepKindGroup StepKind = "group"
)

// Step is one atomic operation in a DeployPlan. The executor decides the
// concrete mechanism (SSH command vs file upload) based on Kind.
type Step struct {
	// Name is a short human label used in logs and `pdatahub-runner plan`.
	Name string
	// Kind classifies the step (see StepKind*).
	Kind StepKind
	// Command is the program to run. For StepKindUpload this is unused (the
	// file lives in the SourcePath field). For StepKindRemote it's an
	// absolute path on the VM or a command in $PATH.
	Command string
	// Args are passed to Command. Never shell-quoted by the planner — the
	// executor is responsible for safe escaping.
	Args []string
	// SourcePath is the runner-local path for StepKindUpload.
	SourcePath string
	// DestPath is the VM-local path for StepKindUpload or StepKindRemote
	// (working directory / script path).
	DestPath string
	// WorkingDir is the directory the step runs in on the VM (defaults to /root).
	WorkingDir string
	// Env is environment variables exported for the step.
	Env map[string]string
	// TimeoutSeconds bounds step execution. Zero = use executor default.
	TimeoutSeconds int
	// FailFast marks a step as required: if it fails, the executor aborts
	// (Phase 1B). Default true for all steps except those explicitly marked.
	FailFast *bool
	// RetryCount is the number of times the executor should retry this step
	// before failing. Default 0.
	RetryCount int
}

// DeployPlan is the ordered list of Steps required to bring hub-core up on
// a single VM. The plan is immutable once returned.
type DeployPlan struct {
	// Steps are executed in order. The plan is valid iff every step is valid.
	Steps []Step
	// TargetVM identifies the VM this plan was built for (set by the executor).
	// Phase 1A: zero-valued; Phase 1B populates from the VM record.
	TargetVM string
	// Version is the hub-core version this plan deploys (matches DeployOpts).
	Version string
	// HubInstanceID is the runner-side UUID of the hub instance (for logging).
	HubInstanceID string
}

// DeployOpts configures PlanDeployment for a single VM.
type DeployOpts struct {
	// HubCoreVersion — e.g. "v0.1.0". Pinned for reproducibility.
	HubCoreVersion string
	// HUBApiToken — 32-byte hex, baked into the .env file. Phase 1B reads
	// from the control-plane DB; Phase 1A accepts it as a parameter.
	HUBApiToken string
	// MagicDNSDomain — e.g. "cloud.pdatahub.io".
	MagicDNSDomain string
	// VMHostname — e.g. "v-xyz789". Used for HUB_PUBLIC_HOSTNAME.
	VMHostname string
	// InstallDir — defaults to /opt/pdatahub/hub-core.
	InstallDir string
	// PublicIPv4 — used for log lines / future cross-VM tooling.
	PublicIPv4 string
	// HubInstanceID — for logging and audit trail.
	HubInstanceID string
	// ReleasesBaseURL — defaults to https://github.com/pdatahub/pdatahub/releases/download.
	// Override for testing or when using a fork.
	ReleasesBaseURL string
	// ChecksumsBaseURL — defaults to ReleasesBaseURL + ".sha256sum".
	// Override for testing.
	ChecksumsBaseURL string
}

// Defaults populated by PlanDeployment when fields are empty.
const (
	DefaultInstallDir        = "/opt/pdatahub/hub-core"
	DefaultReleasesBaseURL   = "https://github.com/pdatahub/pdatahub/releases/download"
	DefaultSystemdUnitPath   = "/etc/systemd/system/pdatahub-hub.service"
	DefaultEnvFilePath       = "/etc/pdatahub/hub.env"
	DefaultWorkingDir        = "/root"
	DefaultRemoteTimeoutSec  = 60
	DefaultDownloadTimeoutSec = 300
	DefaultHealthTimeoutSec  = 30
)

// PlanDeployment builds the ordered Step list for installing hub-core on a
// single VM. The returned plan is pure data — no I/O.
//
// Steps (in order):
//
//  1. Verify Hetzner metadata is reachable (curl instance metadata)
//  2. Download SHA256SUMS file from GitHub Releases
//  3. Download hub-core tarball
//  4. Verify tarball SHA256 against the manifest
//  5. Extract tarball to InstallDir
//  6. Stamp /opt/pdatahub/hub-core/.installed-version
//  7. Write /etc/pdatahub/hub.env (HUB_API_TOKEN, HUB_PUBLIC_HOSTNAME, etc.)
//  8. Write systemd unit /etc/systemd/system/pdatahub-hub.service
//  9. systemctl daemon-reload
// 10. systemctl enable --now pdatahub-hub.service
// 11. Health-check loop: GET /v1/identity (retry up to DefaultHealthTimeoutSec)
func PlanDeployment(opts DeployOpts) (*DeployPlan, error) {
	if err := opts.validate(); err != nil {
		return nil, err
	}
	opts = opts.withDefaults()

	plan := &DeployPlan{
		Version:       opts.HubCoreVersion,
		HubInstanceID: opts.HubInstanceID,
		TargetVM:      opts.PublicIPv4,
	}

	tarball := fmt.Sprintf("pdatahub-hub-core-%s.tgz", opts.HubCoreVersion)
	checksumFile := "SHA256SUMS"

	// 1. Verify instance metadata reachable (sanity for cloud env).
	plan.Steps = append(plan.Steps, Step{
		Name:           "verify-instance-metadata",
		Kind:           StepKindRemote,
		Command:        "curl",
		Args:           []string{"-fsS", "--max-time", "5", "http://169.254.169.254/hetzner/v1/metadata/instance-id"},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 10,
	})

	// 2. Download checksums file.
	checksumsURL := fmt.Sprintf("%s/%s/%s", opts.ChecksumsBaseURL, opts.HubCoreVersion, checksumFile)
	plan.Steps = append(plan.Steps, Step{
		Name:           "download-sha256sums",
		Kind:           StepKindRemote,
		Command:        "curl",
		Args:           []string{"-fsSL", "--max-time", "30", "-o", "/tmp/" + checksumFile, checksumsURL},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: DefaultDownloadTimeoutSec,
		RetryCount:     2,
	})

	// 3. Download hub-core tarball.
	tarballURL := fmt.Sprintf("%s/%s/%s", opts.ReleasesBaseURL, opts.HubCoreVersion, tarball)
	plan.Steps = append(plan.Steps, Step{
		Name:           "download-tarball",
		Kind:           StepKindRemote,
		Command:        "curl",
		Args:           []string{"-fsSL", "--max-time", "60", "-o", "/tmp/" + tarball, tarballURL},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: DefaultDownloadTimeoutSec,
		RetryCount:     2,
	})

	// 4. Verify SHA256.
	plan.Steps = append(plan.Steps, Step{
		Name:    "verify-sha256",
		Kind:    StepKindRemote,
		Command: "sha256sum",
		Args:    []string{"--check", "--strict", "--status"},
		WorkingDir: DefaultWorkingDir,
		Env: map[string]string{
			// sha256sum --check --strict looks for a file whose basename
			// matches the input. We pass the checksums file via stdin
			// redirection; the Env here is informational only.
			"CHECKSUMS_FILE": "/tmp/" + checksumFile,
		},
		// Override Command+Args with a one-liner that does the right thing.
		// (sha256sum --check needs a positional argument or stdin redirect;
		// we use a shell pipeline via bash -c so the planner stays simple.)
		TimeoutSeconds: 30,
	})

	// Replace step 4 with a shell-friendly version (above kept for inspection).
	plan.Steps[3] = Step{
		Name:    "verify-sha256",
		Kind:    StepKindRemote,
		Command: "bash",
		Args: []string{
			"-c",
			"cd /tmp && grep '" + tarball + "' " + checksumFile + " | sha256sum --check --status",
		},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 30,
	}

	// 5. Extract tarball.
	plan.Steps = append(plan.Steps, Step{
		Name:           "extract-tarball",
		Kind:           StepKindRemote,
		Command:        "tar",
		Args:           []string{"-xzf", "/tmp/" + tarball, "-C", opts.InstallDir, "--strip-components=1"},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 60,
	})

	// 6. Stamp installed version.
	failFast := true
	plan.Steps = append(plan.Steps, Step{
		Name:    "stamp-installed-version",
		Kind:    StepKindRemote,
		Command: "bash",
		Args: []string{
			"-c",
			fmt.Sprintf("mkdir -p %s && echo %q > %s/.installed-version", opts.InstallDir, opts.HubCoreVersion, opts.InstallDir),
		},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 10,
		FailFast:       &failFast,
	})

	// 7. Write hub.env.
	envFileContent := buildEnvFile(opts)
	plan.Steps = append(plan.Steps, Step{
		Name:    "write-hub-env",
		Kind:    StepKindRemote,
		Command: "bash",
		Args: []string{
			"-c",
			fmt.Sprintf("mkdir -p %s && cat > %s <<'EOF'\n%sEOF", dirOf(DefaultEnvFilePath), DefaultEnvFilePath, envFileContent),
		},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 10,
	})

	// 8. Write systemd unit (content baked at plan time).
	systemdUnit := buildSystemdUnit(opts)
	plan.Steps = append(plan.Steps, Step{
		Name:    "write-systemd-unit",
		Kind:    StepKindRemote,
		Command: "bash",
		Args: []string{
			"-c",
			fmt.Sprintf("cat > %s <<'EOF'\n%sEOF", DefaultSystemdUnitPath, systemdUnit),
		},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 10,
	})

	// 9. systemctl daemon-reload.
	plan.Steps = append(plan.Steps, Step{
		Name:           "systemd-daemon-reload",
		Kind:           StepKindRemote,
		Command:        "systemctl",
		Args:           []string{"daemon-reload"},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 15,
	})

	// 10. systemctl enable --now.
	plan.Steps = append(plan.Steps, Step{
		Name:           "systemd-enable-now",
		Kind:           StepKindRemote,
		Command:        "systemctl",
		Args:           []string{"enable", "--now", "pdatahub-hub.service"},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: 30,
	})

	// 11. Health-check loop.
	plan.Steps = append(plan.Steps, Step{
		Name:    "health-check",
		Kind:    StepKindRemote,
		Command: "bash",
		Args: []string{
			"-c",
			"for i in $(seq 1 " + fmt.Sprint(DefaultHealthTimeoutSec) + "); do if curl -fsS http://127.0.0.1:8080/v1/identity >/dev/null 2>&1; then echo \"hub-core ready after ${i}s\"; exit 0; fi; sleep 1; done; echo \"hub-core did NOT become ready\" >&2; exit 1",
		},
		WorkingDir:     DefaultWorkingDir,
		TimeoutSeconds: DefaultHealthTimeoutSec + 5,
	})

	return plan, nil
}

// validate ensures the minimum required fields are present. Empty defaults
// are filled in by withDefaults, not here, so the caller can distinguish
// "user left it blank" from "we filled in a default".
func (o DeployOpts) validate() error {
	if o.HubCoreVersion == "" {
		return errors.New("hubcore: HubCoreVersion is required")
	}
	if !strings.HasPrefix(o.HubCoreVersion, "v") {
		return fmt.Errorf("hubcore: HubCoreVersion %q must start with 'v'", o.HubCoreVersion)
	}
	if o.HUBApiToken == "" {
		return errors.New("hubcore: HUBApiToken is required")
	}
	if o.MagicDNSDomain == "" {
		return errors.New("hubcore: MagicDNSDomain is required")
	}
	if o.VMHostname == "" {
		return errors.New("hubcore: VMHostname is required")
	}
	return nil
}

func (o DeployOpts) withDefaults() DeployOpts {
	if o.InstallDir == "" {
		o.InstallDir = DefaultInstallDir
	}
	if o.ReleasesBaseURL == "" {
		o.ReleasesBaseURL = DefaultReleasesBaseURL
	}
	if o.ChecksumsBaseURL == "" {
		// SHA256SUMS lives in the same release directory as the tarball.
		o.ChecksumsBaseURL = o.ReleasesBaseURL
	}
	return o
}

// buildEnvFile returns the contents of /etc/pdatahub/hub.env.
//
// We always embed via heredoc so multi-character values with quotes work.
func buildEnvFile(o DeployOpts) string {
	hostname := fmt.Sprintf("%s.%s", o.VMHostname, o.MagicDNSDomain)
	return fmt.Sprintf("HUB_API_TOKEN=%s\nHUB_LISTEN_ADDR=0.0.0.0:8080\nHUB_PUBLIC_HOSTNAME=%s\nHUB_TAILSCALE_DOMAIN=%s\n",
		o.HUBApiToken, hostname, o.MagicDNSDomain)
}

// buildSystemdUnit returns the contents of the hub-core systemd unit.
//
// Mirrors the cloud-init script generator; the two must stay in sync.
func buildSystemdUnit(o DeployOpts) string {
	return fmt.Sprintf(`[Unit]
Description=pdatahub hub-core (instance=%s, host=%s)
After=network-online.target tailscaled.service
Wants=network-online.target
Requires=tailscaled.service

[Service]
Type=simple
User=root
WorkingDirectory=%s
EnvironmentFile=%s
ExecStart=/usr/bin/env node %s/dist/index.js
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`,
		o.HubInstanceID, o.VMHostname, o.InstallDir, DefaultEnvFilePath, o.InstallDir,
	)
}

// dirOf returns the parent directory of a POSIX-style path. Used to
// mkdir -p the parent of an env file before writing.
func dirOf(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

// ReleasesURL is exported so tests can assert the exact URL format.
func ReleasesURL(opts DeployOpts) string {
	opts = opts.withDefaults()
	u, _ := url.JoinPath(opts.ReleasesBaseURL, opts.HubCoreVersion, fmt.Sprintf("pdatahub-hub-core-%s.tgz", opts.HubCoreVersion))
	return u
}