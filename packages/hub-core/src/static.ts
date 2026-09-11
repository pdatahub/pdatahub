/**
 * Static file serving for the embedded web UI.
 *
 * Hub core ships a SvelteKit SPA in `packages/web/build/`. When the
 * user opens `http://hub:8080/` the server must serve the SPA shell
 * (and its hashed asset bundles) WITHOUT requiring the bearer token —
 * otherwise the user is stuck in a redirect loop: they need a token to
 * load the page, but they need the page to enter a token.
 *
 * The solution: serve static files BEFORE the auth check, but only for
 * paths that don't match the API surface (`/v1/*`, `/health`,
 * `/approval-stream`). API/WS traffic goes through the normal pipeline.
 *
 * ## SPA fallback
 *
 * SvelteKit adapter-static with `fallback: 'index.html'` means the
 * server must return `index.html` for any path that doesn't match a
 * real file on disk. We use a simple heuristic:
 *
 *   - path has no `.` extension (e.g. `/`, `/approval`, `/settings`)
 *     → always serve `index.html`
 *   - path has an extension (e.g. `/favicon.ico`, `/_app/immutable/x.js`)
 *     → try to serve that file; 404 if missing
 *
 * ## Path traversal protection
 *
 * `pathname` from `URL.pathname` is already URL-decoded by Node. We
 * still resolve the requested path against `webRoot` and verify the
 * resolved path is INSIDE `webRoot` — defense in depth against
 * `..`-in-query-string attacks that some HTTP clients don't strip.
 *
 * ## Caching
 *
 * SvelteKit emits `/_app/immutable/...` chunks with content hashes in
 * the filename, so they're effectively immutable → 1-year
 * `max-age=31536000, immutable`. The entry `index.html` is
 * `no-cache` so deploys are picked up on the next page load.
 *
 * Exported for unit testing in `tests/static.test.ts`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * API/WS paths that must NEVER be intercepted by the static handler.
 *
 * - `/v1/*` is the API surface — exact-prefix match (with trailing slash)
 *   so `/v1identity` (a hypothetical future SPA route) still gets the SPA
 *   shell rather than a 401.
 * - `/health` and `/approval-stream` are exact-match only — `/healthcheck`
 *   or `/approval-stream-foo` should fall through to the static handler
 *   (and 404, since we don't ship those routes).
 */
const API_PREFIXES = ['/v1/'];
const API_EXACT = ['/health', '/approval-stream'];

/**
 * Tiny inline MIME map. Avoids the `mime-types` dependency for a 20-entry
 * allow-list — every extension the SvelteKit build actually emits.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Public: which paths the static handler must skip (API/WS). */
export function isApiPath(pathname: string): boolean {
  if (API_EXACT.includes(pathname)) return true;
  for (const prefix of API_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

/** Public: MIME type lookup with sensible fallback. */
export function getMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Public: cache strategy per file (SvelteKit's immutable asset convention). */
function cacheControlFor(filePath: string): string {
  if (filePath.includes('/_app/')) {
    // Hashed bundle names — safe to cache forever.
    return 'public, max-age=31536000, immutable';
  }
  if (filePath.endsWith('index.html') || filePath.endsWith('200.html')) {
    // SPA entry — must revalidate so deploys are picked up.
    return 'no-cache';
  }
  // Static assets (favicon, etc.) — short cache with revalidation.
  return 'public, max-age=3600, must-revalidate';
}

/**
 * Resolve `pathname` to a file path under `webRoot`, defending against
 * path traversal. Returns `null` if the resolved path escapes webRoot.
 *
 * Public for testing — the SPA fallback logic in `serveStatic` reuses
 * this to validate paths before reading from disk.
 */
export function resolveSafePath(webRoot: string, pathname: string): string | null {
  // Reject obvious traversal vectors. URL.pathname is already decoded,
  // but a defensive check costs nothing.
  if (pathname.includes('..')) return null;

  const webRootResolved = resolve(webRoot);
  const candidate = resolve(webRootResolved, '.' + pathname);

  // Ensure the resolved path is INSIDE webRoot (no symlink-style escapes).
  const sepNix = sep;
  if (
    candidate !== webRootResolved &&
    !candidate.startsWith(webRootResolved + sepNix)
  ) {
    return null;
  }
  return candidate;
}

/**
 * Serve a static file from `webRoot` for the given request.
 *
 * Returns `true` if the request was handled (file served, fallback
 * served, or error response sent). Returns `false` if the request
 * matches an API path and should be passed through to the normal
 * dispatch pipeline.
 *
 * Behavior:
 *   - `/v1/*`, `/health`, `/approval-stream` → return false (don't intercept)
 *   - Path without extension (e.g. `/approval`) → serve `index.html` (SPA fallback)
 *   - Path with extension that exists → serve the file with appropriate cache headers
 *   - Path with extension that's missing → 404
 *   - Path traversal (`..`) → 403
 */
export function serveStatic(
  res: ServerResponse,
  webRoot: string,
  pathname: string,
): boolean {
  if (isApiPath(pathname)) return false;

  const safePath = resolveSafePath(webRoot, pathname);
  if (safePath === null) {
    res.statusCode = 403;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Forbidden');
    return true;
  }

  // Decide which file to serve:
  //   - no extension OR exact `/` → SPA fallback to index.html
  //   - has extension → serve that exact file
  const isSpaRoute = pathname === '/' || !pathname.includes('.');
  const target = isSpaRoute ? join(webRoot, 'index.html') : safePath;

  if (!existsSync(target)) {
    if (isSpaRoute) {
      // webRoot exists but index.html is missing — fatal config error.
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('web UI not built (index.html missing in webRoot)');
      return true;
    }
    // Static asset 404 (e.g. /favicon.ico not provided).
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return true;
  }

  // Refuse to serve directories — Node would return the dir's bytes
  // or fail confusingly. Return 400 so the client knows it's a bad
  // request, not a missing file.
  if (!statSync(target).isFile()) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Bad Request');
    return true;
  }

  const content = readFileSync(target);
  res.statusCode = 200;
  res.setHeader('content-type', getMimeType(target));
  res.setHeader('cache-control', cacheControlFor(target));
  // x-content-type-options: block MIME sniffing for SVG (defense in
  // depth — SVG can carry script; we don't currently allow uploads,
  // but cheap to set).
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(content);
  return true;
}
