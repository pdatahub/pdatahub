/**
 * Cross-platform OS-native keyring storage for the master encryption key.
 *
 * T-PERSISTENT-001 mitigation #1 — removes the trivial `/proc/<pid>/cmdline`
 * exfiltration vector. Instead of passing `master_key` as a CLI argument
 * (world-readable on Linux by default), the hub can now source the master
 * key from the user's OS keyring:
 *
 *   - Linux:   Secret Service via libsecret / gnome-keyring
 *   - macOS:   Keychain
 *   - Windows: DPAPI
 *
 * In all three cases the master key is **process-isolated** — a non-root
 * user cannot read another user's keyring entry. An attacker who already
 * has the user's login session has a much higher bar than reading
 * `/proc/<pid>/cmdline` from any user.
 *
 * Design constraints:
 *
 *   1. **Graceful degradation.** The keyring library is a native module —
 *      it may fail to load on unsupported platforms, on hosts with no
 *      Secret Service daemon, or when the user is running in a sandbox
 *      that lacks IPC. The hub MUST continue to boot in that case, falling
 *      back to the legacy --master-key / --passphrase / HUB_MASTER_KEY
 *      paths with a clear warning. NEVER crash on startup.
 *
 *   2. **No logging of secrets.** The master key bytes must never appear in
 *      logs, even at debug level. We log only the *fact* of a hit/miss.
 *
 *   3. **Testable.** All platform-specific calls go through a thin
 *      `EntryBackend` interface. Tests inject a mock backend; production
 *      uses the real @napi-rs/keyring binding.
 *
 *   4. **Async.** The underlying library exposes both sync (Entry) and
 *      async (AsyncEntry) variants. We use the async variant exclusively
 *      because the secret service daemon (D-Bus on Linux) is itself an
 *      IPC call. Blocking the event loop on hub startup is undesirable.
 */

import { logger } from './logger.js';

/* ------------------------------------------------------------------------- */
/* Backend abstraction                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Minimal async-only interface that both the real native library and any
 * test mock must satisfy. Defined as a structural type so the test mock
 * does not have to import or extend @napi-rs/keyring.
 */
export interface EntryBackend {
  /** Store `secret` for the given (service, account). */
  setSecret(service: string, account: string, secret: Uint8Array): Promise<void>;
  /** Retrieve the secret. Returns null if no entry exists. */
  getSecret(service: string, account: string): Promise<Uint8Array | null>;
  /** Remove the entry. Returns true if removed, false if it was already absent. */
  deleteSecret(service: string, account: string): Promise<boolean>;
  /**
   * Returns true iff the backend is loaded and operational. Implementations
   * may report false if the native binding failed to load, or if the
   * platform's secret service daemon is unreachable.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Human-readable name of the backend (e.g. "@napi-rs/keyring linux x64").
   * Used in the "keyring unavailable" warning log so users know what we tried.
   */
  backendName(): string;
}

/* ------------------------------------------------------------------------- */
/* Real backend — @napi-rs/keyring                                            */
/* ------------------------------------------------------------------------- */

/**
 * Backend backed by @napi-rs/keyring (keyring-rs via NAPI-RS).
 * Lazily loaded — `require` is deferred until first use so that the import
 * itself never crashes if the native binding is missing for the host
 * platform. Tests mock the module via vitest's `vi.mock` mechanism.
 */
class NapiKeyringBackend implements EntryBackend {
  private mod: typeof import('@napi-rs/keyring') | null = null;
  private loadError: Error | null = null;
  /**
   * In-flight load promise. Multiple concurrent callers (e.g. parallel
   * `setSecret` + `getSecret` during startup) share a single dynamic
   * import — `await import()` in ESM caches the resolved module, but
   * caching the promise avoids redundant import work.
   */
  private loadPromise: Promise<typeof import('@napi-rs/keyring')> | null = null;
  /** Cached human-readable backend identifier, e.g. "linux x64-gnu". */
  private readonly platformLabel: string;

  constructor() {
    this.platformLabel = `${process.platform} ${process.arch}`;
  }

  private async getMod(): Promise<typeof import('@napi-rs/keyring')> {
    if (this.mod) return this.mod;
    if (this.loadError) throw this.loadError;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        // Dynamic import — works in both ESM and CJS, unlike `require`
        // which is undefined in ESM modules. The failure mode is
        // contained to this module rather than crashing the hub at
        // import time, because the `import('@napi-rs/keyring')` is
        // lazy — only triggered when a keyring function is called.
        const mod = (await import('@napi-rs/keyring')) as typeof import('@napi-rs/keyring');
        if (!mod || !mod.AsyncEntry) {
          throw new Error('@napi-rs/keyring loaded but is missing AsyncEntry');
        }
        this.mod = mod;
        return mod;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.loadError = e;
        throw e;
      }
    })();
    return this.loadPromise;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getMod();
      return true;
    } catch {
      return false;
    }
  }

  backendName(): string {
    return `@napi-rs/keyring (${this.platformLabel})`;
  }

  async setSecret(service: string, account: string, secret: Uint8Array): Promise<void> {
    const mod = await this.getMod();
    const entry = new mod.AsyncEntry(service, account);
    await entry.setSecret(secret);
  }

  async getSecret(service: string, account: string): Promise<Uint8Array | null> {
    const mod = await this.getMod();
    const entry = new mod.AsyncEntry(service, account);
    const secret = await entry.getSecret();
    return secret ?? null;
  }

  async deleteSecret(service: string, account: string): Promise<boolean> {
    const mod = await this.getMod();
    const entry = new mod.AsyncEntry(service, account);
    return await entry.deleteCredential();
  }
}

/* ------------------------------------------------------------------------- */
/* Module state                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The active backend. Tests inject a mock via `setBackendForTesting`. The
 * production backend is the singleton NapiKeyringBackend.
 */
let activeBackend: EntryBackend = new NapiKeyringBackend();

/**
 * Test-only: replace the backend. Pass null to restore the default
 * (production) backend.
 *
 * @internal
 */
export function setBackendForTesting(backend: EntryBackend | null): void {
  if (backend === null) {
    activeBackend = new NapiKeyringBackend();
  } else {
    activeBackend = backend;
  }
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Returns true iff the OS keyring is loaded and operational on this host.
 * Callers use this to decide whether to log the "keyring unavailable"
 * warning vs. silently using keyring.
 */
export async function isKeyringAvailable(): Promise<boolean> {
  return await activeBackend.isAvailable();
}

/**
 * Human-readable backend label (e.g. "@napi-rs/keyring (linux x64)").
 * Surfaced in logs and in the `keyring show` CLI output.
 */
export function keyringBackendLabel(): string {
  return activeBackend.backendName();
}

/**
 * Store the master key bytes in the OS keyring under (service, account).
 *
 * @param key 32-byte master key. MUST be exactly 32 bytes (AES-256 length).
 * @param service Keyring service name. Defaults to `pdatahub-hub`.
 * @param account Keyring account/username. Defaults to `master-key`.
 */
export async function setMasterKey(
  key: Buffer,
  service: string = 'pdatahub-hub',
  account: string = 'master-key',
): Promise<void> {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('master key must be a 32-byte Buffer');
  }
  if (!service || !account) {
    throw new Error('service and account must be non-empty strings');
  }
  await activeBackend.setSecret(service, account, new Uint8Array(key));
}

/**
 * Retrieve the master key from the OS keyring. Returns null if no entry
 * exists for (service, account) — this is the normal "first run" case
 * and is NOT an error.
 *
 * Re-throws on backend errors (e.g. daemon unreachable, permission
 * denied). Callers should wrap in try/catch and fall back to CLI arg
 * if the backend is unhealthy.
 */
export async function getMasterKey(
  service: string = 'pdatahub-hub',
  account: string = 'master-key',
): Promise<Buffer | null> {
  const secret = await activeBackend.getSecret(service, account);
  if (secret === null) return null;
  if (secret.length !== 32) {
    // Defensive: the keyring returned garbage (should never happen, but
    // better to fail loud than silently use a wrong-length key).
    throw new Error(
      `keyring entry has unexpected length ${secret.length} (expected 32)`,
    );
  }
  return Buffer.from(secret);
}

/**
 * Returns true iff a master key is currently stored in the OS keyring
 * under (service, account).
 *
 * This is a non-throwing variant of `getMasterKey` for callers that only
 * care about presence (e.g. CLI `keyring show`). It swallows backend
 * errors and returns false in that case.
 */
export async function hasMasterKey(
  service: string = 'pdatahub-hub',
  account: string = 'master-key',
): Promise<boolean> {
  try {
    const secret = await activeBackend.getSecret(service, account);
    return secret !== null;
  } catch (err) {
    logger.warn('keyring hasMasterKey check failed', {
      error: (err as Error).message,
      backend: activeBackend.backendName(),
    });
    return false;
  }
}

/**
 * Remove the master key entry from the OS keyring. Idempotent — calling
 * on an absent entry is a no-op (returns false).
 *
 * Used by `pdatahub-hub keyring clear` and by master-key rotation flows.
 */
export async function deleteMasterKey(
  service: string = 'pdatahub-hub',
  account: string = 'master-key',
): Promise<boolean> {
  return await activeBackend.deleteSecret(service, account);
}

/**
 * Log a one-time "keyring unavailable" warning, explaining the fallback.
 * Idempotent — safe to call on every hub boot, will only emit once per
 * process unless the user acks with `--ack-insecure-master-key`.
 *
 * The message explicitly tells the user:
 *   1. What fallback is being used (CLI arg / env / passphrase)
 *   2. Why it matters (process listing exposure)
 *   3. How to fix (install Secret Service daemon, run --store-keyring)
 *   4. How to silence the warning (--ack-insecure-master-key)
 *
 * Must NEVER log the master key bytes — only the fallback source.
 */
let warnedAboutFallback = false;
export function warnKeyringUnavailableOnce(reason: string, fallbackSource: string): void {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  logger.warn(
    'master_key not loaded from OS keyring — falling back to ' + fallbackSource,
    {
      reason,
      fallback: fallbackSource,
      risk:
        'master_key will be visible in /proc/<pid>/cmdline (Linux) or process ' +
        'env (all OSes). An unprivileged local user can extract it.',
      remediation:
        'install libsecret + gnome-keyring on Linux, macOS Keychain on ' +
        'darwin, or use Credential Manager on Windows. Then run: ' +
        'pdatahub-hub --store-keyring <hex>',
      suppress_with: '--ack-insecure-master-key',
    },
  );
}

/**
 * Test-only: reset the "warned once" latch so a test can re-trigger the
 * warning. Production code should not call this.
 *
 * @internal
 */
export function resetWarnedAboutFallbackForTesting(): void {
  warnedAboutFallback = false;
}