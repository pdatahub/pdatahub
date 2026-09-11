<script lang="ts">
  /**
   * Settings page — hub info + API token entry.
   *
   * First-run UX: when the user opens the web UI without a token, every
   * API call returns 401. This page is the only one reachable without a
   * token (because `/v1/identity` is public and the Settings page itself
   * is served by the static handler before auth).
   *
   * Flow:
   *   1. Page loads, fetches /v1/identity (no auth) → shows hub info
   *   2. User pastes API token (found in `make logs` or `docker logs pdatahub-hub`)
   *   3. Token saved to sessionStorage via session store
   *   4. If `?from=/audit` (etc.) was passed, redirect there after save
   *
   * Token handling:
   *   - Stored in sessionStorage (cleared on tab close) — we don't want a
   *     persistent token in localStorage where it survives forever.
   *   - Never sent anywhere except as `Authorization: Bearer` on hub requests.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { api, HubError } from '$lib/api';
  import { session, setApiToken } from '$lib/stores/session';
  import type { IdentityResponse, StatusResponse } from '$lib/types';

  let identity = $state<IdentityResponse | null>(null);
  let identityError = $state<string | null>(null);
  let status = $state<StatusResponse | null>(null);
  let statusError = $state<string | null>(null);
  let tokenInput = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let showToken = $state(false);
  let copyState = $state<'idle' | 'copied'>('idle');

  onMount(async () => {
    try {
      identity = await api.identity();
    } catch (err) {
      identityError = err instanceof Error ? err.message : 'unknown';
    }
    // Status is bearer-authenticated — only fetch when we have a token.
    if ($session.apiToken) {
      try {
        status = await api.status();
      } catch (err) {
        statusError = err instanceof Error ? err.message : 'unknown';
      }
    }
  });

  async function handleSave(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      saveError = 'Token cannot be empty';
      return;
    }
    saving = true;
    saveError = null;
    setApiToken(trimmed);
    // Verify the token works against a real authenticated call. /v1/tools
    // is the cheapest endpoint that requires auth.
    try {
      await api.listTools();
    } catch (err) {
      // Roll back: the token was rejected, clear it.
      setApiToken('');
      saveError =
        err instanceof HubError
          ? `Token rejected (${err.status}: ${err.hubCode}). Double-check from \`make logs\`.`
          : `Token rejected: ${err instanceof Error ? err.message : 'unknown'}`;
      saving = false;
      return;
    }
    saving = false;
    const from = $page.url.searchParams.get('from');
    if (from && from.startsWith('/') && !from.startsWith('//')) {
      goto(from);
    }
  }

  function handleClear() {
    setApiToken('');
    tokenInput = '';
  }

  async function copyToken() {
    const stored = $session.apiToken;
    if (!stored) return;
    try {
      await navigator.clipboard.writeText(stored);
      copyState = 'copied';
      setTimeout(() => (copyState = 'idle'), 1500);
    } catch {
      // clipboard API might be unavailable — non-fatal
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
</script>

<svelte:head>
  <title>Settings · pdatahub</title>
</svelte:head>

<section class="settings">
  <h1>Settings</h1>

  <article class="card">
    <h2>Hub</h2>
    {#if identity}
      <dl>
        <dt>Hub name</dt>
        <dd><code>{identity.hub_name}</code></dd>
        {#if identity.magic_dns}
          <dt>Magic DNS</dt>
          <dd><code>{identity.magic_dns}</code></dd>
        {/if}
        <dt>Fingerprint</dt>
        <dd><code>{identity.fingerprint}</code></dd>
        <dt>Verify key</dt>
        <dd><code class="long">{identity.verify_key}</code></dd>
      </dl>
      <p class="hint">
        The fingerprint is what you compare with peers when establishing federation —
        not the API token.
      </p>
    {:else if identityError}
      <p class="error">Could not load hub identity: {identityError}</p>
    {:else}
      <p class="muted">Loading hub info…</p>
    {/if}
  </article>

  {#if $session.apiToken}
    <article class="card">
      <h2>System</h2>
      {#if status}
        <dl>
          <dt>Hub URL</dt>
          <dd><code>{window.location.origin}</code></dd>
          <dt>Version</dt>
          <dd>v{status.hub_version}</dd>
          <dt>Uptime</dt>
          <dd>{formatUptime(status.uptime_sec)}</dd>
          <dt>Plugins installed</dt>
          <dd>
            <code>{status.plugin_count}</code>
            {#if status.plugin_count === 0}
              <span class="hint-inline">— install one in the <a href="/plugins">Plugins</a> tab</span>
            {/if}
          </dd>
          <dt>WebSocket clients</dt>
          <dd>
            <code>{status.ws_clients}</code>
            <span class="hint-inline">— phones + web UIs connected to approval stream</span>
          </dd>
          <dt>Audit entries</dt>
          <dd><code>{status.audit_count}</code></dd>
          <dt>Federation</dt>
          <dd>
            {#if status.federation_enabled}
              <span class="badge badge-on">enabled</span>
            {:else}
              <span class="badge badge-off">identity-only</span>
            {/if}
          </dd>
          <dt>Rate limit</dt>
          <dd>
            {#if status.rate_limit_enabled}
              <span class="badge badge-on">enabled</span>
            {:else}
              <span class="badge badge-off">disabled</span>
            {/if}
          </dd>
        </dl>
        <p class="hint">
          Auto-refreshes on page load. Federation status reflects the in-memory
          delegation store — grants you issue are listed in <code>/v1/federation/delegations</code>.
        </p>
      {:else if statusError}
        <p class="error">Could not load system status: {statusError}</p>
        <p class="hint">
          Status is bearer-authenticated. If you just added the token above,
          the page will refresh it on next mount.
        </p>
      {:else}
        <p class="muted">Loading system status…</p>
      {/if}
    </article>
  {/if}

  <article class="card">
    <h2>API token</h2>
    {#if $session.apiToken}
      <p class="muted">
        Token saved for this session (stored in sessionStorage, cleared on tab close).
      </p>
      <div class="token-display">
        <code>{showToken ? $session.apiToken : '•'.repeat(Math.min($session.apiToken.length, 64))}</code>
        <div class="row">
          <button type="button" class="btn-small" onclick={() => (showToken = !showToken)}>
            {showToken ? 'Hide' : 'Reveal'}
          </button>
          <button type="button" class="btn-small" onclick={copyToken}>
            {copyState === 'copied' ? 'Copied!' : 'Copy'}
          </button>
          <button type="button" class="btn-small danger" onclick={handleClear}>
            Clear
          </button>
        </div>
      </div>
    {:else}
      <p>
        Paste the API token printed when the hub started. To recover it:
      </p>
      <pre><code>make logs | grep 'API TOKEN' -A 1
# or
docker logs pdatahub-hub 2&gt;&amp;1 | grep 'API TOKEN' -A 1</code></pre>
    {/if}

    <form onsubmit={handleSave}>
      <label for="token">Update token</label>
      <input
        id="token"
        type="password"
        bind:value={tokenInput}
        placeholder="Paste new API token"
        autocomplete="off"
        spellcheck="false"
        disabled={saving}
      />
      <div class="row">
        <button type="submit" class="btn" disabled={saving || !tokenInput.trim()}>
          {saving ? 'Verifying…' : 'Save and verify'}
        </button>
        {#if saveError}
          <span class="error">{saveError}</span>
        {/if}
      </div>
    </form>
  </article>

  <article class="card">
    <h2>About</h2>
    <p>
      <a href="https://github.com/pdatahub/pdatahub">pdatahub</a> ·
      <a href="https://github.com/pdatahub/pdatahub/blob/main/docs/threat-model.md">Threat model</a> ·
      <a href="https://github.com/pdatahub/pdatahub/blob/main/docs/privacy.md">Privacy</a>
    </p>
  </article>
</section>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 720px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    color: var(--fg);
  }
  h2 {
    margin: 0 0 var(--space-3) 0;
    font-size: 18px;
    color: var(--accent);
  }
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-5);
  }
  dl {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--fg-dim);
    font-size: 13px;
  }
  dd {
    margin: 0;
    color: var(--fg);
    font-size: 14px;
  }
  code {
    font-family: var(--font-mono, ui-monospace, 'JetBrains Mono', monospace);
    font-size: 13px;
    color: var(--accent);
    background: var(--bg);
    padding: 2px 6px;
    border-radius: 4px;
  }
  code.long {
    word-break: break-all;
  }
  .hint {
    margin: var(--space-3) 0 0 0;
    color: var(--fg-mute);
    font-size: 13px;
  }
  .muted {
    color: var(--fg-dim);
  }
  .error {
    color: #ef4444;
    font-size: 13px;
  }
  pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    overflow-x: auto;
  }
  pre code {
    background: transparent;
    padding: 0;
    color: var(--fg);
    font-size: 12px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  label {
    color: var(--fg-dim);
    font-size: 13px;
  }
  input {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    font-family: var(--font-mono, monospace);
    font-size: 13px;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .btn {
    background: var(--accent);
    color: var(--bg);
    border: none;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
  }
  .btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-small {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
  }
  .btn-small:hover {
    border-color: var(--accent);
  }
  .btn-small.danger {
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.3);
  }
  .token-display {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    margin: var(--space-3) 0;
  }
  .token-display code {
    display: block;
    word-break: break-all;
    margin-bottom: var(--space-2);
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 600;
  }
  .badge-on {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success, #4ade80);
  }
  .badge-off {
    background: rgba(148, 163, 184, 0.15);
    color: var(--fg-dim);
  }
  .hint-inline {
    color: var(--fg-mute);
    font-size: 12px;
    margin-left: var(--space-2);
  }
  .hint-inline a {
    color: var(--accent);
  }
</style>
