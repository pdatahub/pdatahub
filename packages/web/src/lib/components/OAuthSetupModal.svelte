<script lang="ts">
  /**
   * OAuth credentials setup modal.
   *
   * Two input modes:
   *   - "raw": client_id + optional client_secret fields (Slack, Todoist, etc.)
   *   - "google": paste the OAuth client JSON downloaded from Google Cloud Console
   *
   * On submit: PUTs to /v1/plugins/:name/oauth/credentials, then optionally
   * starts the OAuth dance (open popup with authorization_url).
   *
   * The popup-detect-close loop polls oauthStatus every 1.5s while the
   * popup is open — when connected flips to true, we close the popup
   * and refresh the parent. Manual cancel via "Cancel" button.
   */
  import { api, HubError } from '$lib/api';
  import type { OAuthCredentialsInput, OAuthStatusResponse } from '$lib/types';

  type Mode = 'raw' | 'google';

  let {
    pluginName,
    status = $bindable<OAuthStatusResponse | null>(null),
    onClose,
  }: {
    pluginName: string;
    status?: OAuthStatusResponse | null;
    onClose: () => void;
  } = $props();

  let mode = $state<Mode>('raw');
  let clientId = $state('');
  let clientSecret = $state('');
  let googleJson = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Connect-flow state
  let connecting = $state(false);
  let connectPopup: Window | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function save() {
    error = null;
    saving = true;
    try {
      let body: OAuthCredentialsInput;
      if (mode === 'google') {
        // Hub validates JSON shape — surface 400 errors directly.
        body = { google_oauth_client_json: googleJson.trim() };
      } else {
        if (!clientId.trim()) {
          error = 'client_id is required';
          return;
        }
        body = {
          client_id: clientId.trim(),
          ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
        };
      }
      await api.setOAuthCredentials(pluginName, body);
      // Refresh status from parent.
      const next = await api.oauthStatus(pluginName);
      status = next;
      error = null;
    } catch (err) {
      error = err instanceof HubError ? `${err.hubCode}: ${err.message}` : String(err);
    } finally {
      saving = false;
    }
  }

  async function connect() {
    error = null;
    connecting = true;
    try {
      const { authorization_url } = await api.startOAuth(pluginName);
      // Open in popup. Same-origin should be fine since hub-core is at
      // the same origin as the web UI. Cross-origin would need postMessage.
      const w = 600;
      const h = 700;
      const left = (window.screen.width - w) / 2;
      const top = (window.screen.height - h) / 2;
      connectPopup = window.open(
        authorization_url,
        'pdatahub-oauth',
        `width=${w},height=${h},left=${left},top=${top}`,
      );
      // Poll for connected status — close popup + modal when ready.
      pollTimer = setInterval(async () => {
        if (connectPopup?.closed) {
          stopPolling();
          connecting = false;
          // Final refresh — the callback may have completed before user closed.
          try {
            const next = await api.oauthStatus(pluginName);
            status = next;
          } catch {
            /* swallow */
          }
          return;
        }
        try {
          const next = await api.oauthStatus(pluginName);
          if (next.connected) {
            status = next;
            connectPopup?.close();
            stopPolling();
            connecting = false;
            onClose();
          }
        } catch {
          /* swallow — keep polling */
        }
      }, 1500);
    } catch (err) {
      error = err instanceof HubError ? `${err.hubCode}: ${err.message}` : String(err);
      connecting = false;
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function cancel() {
    stopPolling();
    connectPopup?.close();
    connecting = false;
    onClose();
  }
</script>

<div
  class="modal-backdrop"
  role="button"
  tabindex="-1"
  onclick={cancel}
  onkeydown={(e) => e.key === 'Escape' && cancel()}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="oauth-modal-title"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <header>
      <h2 id="oauth-modal-title">Configure {pluginName}</h2>
      <button class="close" type="button" onclick={cancel} aria-label="Close">×</button>
    </header>

    <div class="mode-tabs">
      <button
        type="button"
        class:active={mode === 'raw'}
        onclick={() => (mode = 'raw')}
      >Raw fields</button>
      <button
        type="button"
        class:active={mode === 'google'}
        onclick={() => (mode = 'google')}
      >Google JSON</button>
    </div>

    {#if mode === 'raw'}
      <p class="dim">
        For Slack, Todoist, Notion, and most providers. Paste the client_id
        and client_secret from your OAuth app's settings.
      </p>
      <label>
        client_id
        <input
          type="text"
          bind:value={clientId}
          placeholder="12345.67890"
          disabled={saving || connecting}
          autocomplete="off"
        />
      </label>
      <label>
        client_secret <span class="dim">(leave blank for PKCE-only)</span>
        <input
          type="password"
          bind:value={clientSecret}
          placeholder="••••••••"
          disabled={saving || connecting}
          autocomplete="off"
        />
      </label>
    {:else}
      <p class="dim">
        Paste the OAuth client JSON from
        <code>Google Cloud Console → APIs &amp; Services → Credentials → Download JSON</code>.
      </p>
      <label>
        client_secret_*.apps.googleusercontent.com.json
        <textarea
          bind:value={googleJson}
          rows="10"
          placeholder="paste Google OAuth client JSON here"
          disabled={saving || connecting}
        ></textarea>
      </label>
    {/if}

    {#if error}
      <p class="msg" data-kind="error">{error}</p>
    {/if}

    {#if status?.connected}
      <p class="msg" data-kind="success">
        ✓ Connected to {pluginName}{status.expires_at ? ` (token expires ${new Date(status.expires_at).toLocaleString()})` : ''}
      </p>
    {/if}

    <footer>
      <button type="button" class="btn" onclick={cancel} disabled={saving}>
        {status?.connected ? 'Done' : 'Cancel'}
      </button>
      {#if status?.configured && !status.connected}
        <button
          type="button"
          class="btn btn-primary"
          onclick={connect}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      {:else if !status?.connected}
        <button
          type="button"
          class="btn btn-primary"
          onclick={save}
          disabled={saving || (mode === 'raw' ? !clientId.trim() : !googleJson.trim())}
        >
          {saving ? 'Saving…' : 'Save credentials'}
        </button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 1000;
  }
  .modal {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    width: min(540px, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--space-2);
  }
  h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .close {
    background: none;
    border: none;
    font-size: 28px;
    line-height: 1;
    cursor: pointer;
    color: var(--fg-dim);
    padding: 0 var(--space-2);
  }
  .mode-tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--border); }
  .mode-tabs button {
    background: none;
    border: none;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    color: var(--fg-dim);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .mode-tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent, #4f8cff);
  }
  label { display: flex; flex-direction: column; gap: var(--space-1); font-size: 14px; }
  input, textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-2) var(--space-3);
    color: var(--fg);
    font-family: inherit;
    font-size: 14px;
  }
  textarea { font-family: ui-monospace, monospace; font-size: 13px; resize: vertical; }
  .dim { color: var(--fg-dim); font-size: 13px; }
  .msg {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    font-size: 14px;
    margin: 0;
  }
  .msg[data-kind='error'] { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
  .msg[data-kind='success'] { background: rgba(74, 222, 128, 0.15); color: var(--success); }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
  .btn {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 14px;
  }
  .btn-primary {
    background: var(--accent, #4f8cff);
    border-color: transparent;
    color: white;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
