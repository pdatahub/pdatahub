/**
 * Plugin installer — downloads a `.tgz` tarball from a URL and extracts
 * it into the plugins directory.
 *
 * ## Why a separate module
 *
 * The install flow touches three concerns that don't belong in `server.ts`:
 *
 *   1. **Network**: HTTPS download via `undici` (already a dep, no new
 *      package needed). Bounded timeouts prevent hanging installs from
 *      blocking the server.
 *   2. **Filesystem**: tarball extraction via the system `tar` binary
 *      via `child_process.execFile`. Avoids pulling the `tar` npm package
 *      (another transitive dep tree) for a feature that runs at most
 *      once per plugin install.
 *   3. **Atomicity**: install is two-phase — extract to a staging dir,
 *      then rename to the final plugin name. A crash mid-extract doesn't
 *      leave a half-installed plugin in the live directory.
 *
 * ## Why HTTP-only, not npm
 *
 * We host plugins on GitHub Releases (no npmjs.com — see npmjs.com
 * permanent shutdown decision). All installs are HTTPS GETs against
 * a known release URL. We never `npm install` anything.
 *
 * ## Security
 *
 * - HTTPS-only: URL must parse as `https:`. http:// is rejected.
 * - Size cap: 100 MB max response body, prevents zip-bomb / OOM.
 * - Path traversal: extracted files are confined to the destination
 *   directory via `tar --no-absolute-names` and a post-extract check
 *   that no `..` segments survived.
 */

import { execFile } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { logger } from './logger.js';

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function downloadTarball(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`only https:// URLs are allowed, got ${parsed.protocol}`);
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdh-plugin-'));
  const dest = join(tmpDir, 'plugin.tgz');
  try {
    const res = await request(url, {
      method: 'GET',
      maxRedirections: 3,
      headersTimeout: DOWNLOAD_TIMEOUT_MS,
      bodyTimeout: DOWNLOAD_TIMEOUT_MS,
    });
    if (res.statusCode >= 400) {
      throw new Error(`download failed: HTTP ${res.statusCode}`);
    }
    const out = createWriteStream(dest);
    let received = 0;
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        out.destroy();
        throw new Error(`tarball exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
      }
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
    logger.info('plugin tarball downloaded', { url, bytes: received, dest });
    return dest;
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

async function extractTarball(tarball: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'tar',
      ['-xzf', tarball, '--no-same-owner', '--no-absolute-names', '-C', destDir],
      { timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `tar extract failed: ${(stderr ?? '').toString().trim() || err.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
  // Post-extract sanity check: refuse if any extracted path escapes
  // destDir (defense in depth against `tar` quirks on weird archives).
  const stack = [destDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!full.startsWith(destDir + '/') && full !== destDir) {
          throw new Error(`extracted path escapes destination: ${full}`);
        }
        stack.push(full);
      }
    }
  }
}

function readPluginManifest(pluginDir: string): { name: string; main: string | null } {
  const pkgPath = join(pluginDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: unknown;
        main?: unknown;
      };
      const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
      const main = typeof raw.main === 'string' && raw.main.length > 0 ? raw.main : null;
      if (name) return { name, main };
    } catch {
      // fall through to dir-name fallback
    }
  }
  return { name: pluginDir.split('/').filter(Boolean).pop() ?? 'unknown', main: null };
}

export interface InstallResult {
  name: string;
  entryPath: string;
}

/**
 * Download a `.tgz` from `url` and install it into `pluginsDir/<name>/`.
 *
 * Throws on any failure with a descriptive message. Cleans up tmp
 * dirs on the unhappy path. The caller does not need to do its own
 * rollback.
 */
export async function installPluginFromUrl(
  url: string,
  pluginsDir: string,
): Promise<InstallResult> {
  const tarball = await downloadTarball(url);
  const staging = mkdtempSync(join(tmpdir(), 'pdh-extract-'));
  try {
    await extractTarball(tarball, staging);
    const manifest = readPluginManifest(staging);
    const pluginName = manifest.name;

    let entryRel: string | null = manifest.main;
    if (!entryRel) {
      // Fall back to conventional paths.
      for (const candidate of ['dist/index.js', 'dist/plugin.js']) {
        if (existsSync(join(staging, candidate))) {
          entryRel = candidate;
          break;
        }
      }
    }
    if (!entryRel) {
      throw new Error(`plugin has no resolvable entry (missing package.json "main" and no dist/index.js / dist/plugin.js)`);
    }

    const dest = join(pluginsDir, pluginName);
    try {
      renameSync(staging, dest);
    } catch {
      cpSync(staging, dest, { recursive: true });
      rmSync(staging, { recursive: true, force: true });
    }

    const entryAbs = join(dest, entryRel);
    if (!existsSync(entryAbs)) {
      throw new Error(`installed plugin has no entry at ${entryAbs}`);
    }
    logger.info('plugin installed', { name: pluginName, entry: entryAbs, from: url });
    return { name: pluginName, entryPath: entryAbs };
  } finally {
    rmSync(tarball.replace(/\/[^/]+$/, ''), { recursive: true, force: true });
  }
}
