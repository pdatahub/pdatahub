// Command pdatahub-runner is the control-plane daemon for pdatahub Cloud v3.
//
// Phase 1A is a skeleton: it parses flags and exits. No HTTP server, no
// Hetzner client, no SSH. Phase 1B wires the real implementations.
//
// Usage:
//
//	pdatahub-runner --dry-run           # default in Phase 1A
//	pdatahub-runner --port 8081         # bind address (only logged)
//	pdatahub-runner --dry-run=false     # Phase 1B: starts HTTP server (panics today)
//
// The binary is intentionally safe to run today: --dry-run prints the
// intended startup line and exits 0. Without --dry-run the binary panics so
// nobody accidentally deploys an unfinished control plane.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

// Version is the runner version. Bumped manually per Phase.
const Version = "0.1.0-alpha"

// Phase is a one-line description of what this build can do. Phase 1A
// prints "skeleton" so audit logs are unambiguous.
const Phase = "Phase 1A skeleton"

// Flags holds parsed command-line flags. Exposed for testing.
type Flags struct {
	Port    int
	DryRun  bool
	Verbose bool
}

// main is a thin wrapper around Run so tests can exercise the actual code
// without invoking os.Exit.
func main() {
	if err := Run(os.Stdout, os.Stderr, os.Args[1:]...); err != nil {
		// Run only returns an error when flag parsing fails; print to stderr
		// (since the caller's stderr is bound here, not the test's).
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

// Run is the testable entry point. It parses flags from args (defaulting to
// os.Args[1:] if args is nil), writes to stdout/stderr, and returns.
//
//   - nil error = dry-run completed successfully.
//   - non-nil error = flag parsing failed (caller should exit non-zero).
//
// Phase 1B: replace the dry-run branch with real Hetzner + HTTP server.
func Run(stdout, stderr io.Writer, args ...string) error {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}

	fs := flag.NewFlagSet("pdatahub-runner", flag.ContinueOnError)
	fs.SetOutput(stderr)
	port := fs.Int("port", 8081, "HTTP port the runner will bind (Phase 1B only)")
	dryRun := fs.Bool("dry-run", true, "Print intended startup and exit (Phase 1A default)")
	verbose := fs.Bool("verbose", false, "Enable verbose logging")

	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("parse flags: %w", err)
	}

	fmt.Fprintf(stdout, "pdatahub-runner v%s (%s)\n", Version, Phase)

	if *verbose {
		fmt.Fprintf(stdout, "  port    : %d\n", *port)
		fmt.Fprintf(stdout, "  dry-run : %v\n", *dryRun)
	}

	flags := Flags{Port: *port, DryRun: *dryRun, Verbose: *verbose}
	if flags.DryRun {
		fmt.Fprintf(stdout, "Would start runner on :%d — Phase 1B wires real Hetzner client\n", flags.Port)
		return nil
	}

	// Phase 1B: real Hetzner client + HTTP server live here.
	panic("Phase 1B: not implemented")
}