<script lang="ts">
  import { onMount } from 'svelte';
  import { api, HubError } from '$lib/api';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import OAuthSetupModal from '$lib/components/OAuthSetupModal.svelte';
  import type { ListToolsResponse, OAuthStatusResponse, ToolDescriptor } from '$lib/types';

  let tools = $state<ListToolsResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let installUrl = $state('');
  let installing = $state(false);
  let installMsg = $state<{ kind: 'success' | 'error'; text: string } | null>(null);

  let oauthStatus = $state<Record<string, OAuthStatusResponse | null>>({});
  let oauthModalPlugin = $state<string | null>(null);

  const byPlugin = $derived(() => {
    const groups = new Map<string, ToolDescriptor[]>();
    for (const t of tools?.tools ?? []) {
      if (t.federated) continue;
      const arr = groups.get(t.plugin) ?? [];
      arr.push(t);
      groups.set(t.plugin, arr);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  async function load() {
    loading = true;
    error = null;
    try {
      tools = await api.listTools();
    } catch (err) {
      error = err instanceof HubError ? err.message : String(err);
    } finally {
      loading = false;
    }
    for (const [name] of byPlugin()) {
      try {
        const s = await api.oauthStatus(name);
        oauthStatus = { ...oauthStatus, [name]: s };
      } catch {
        oauthStatus = { ...oauthStatus, [name]: null };
      }
    }
  }

  async function install() {
    if (!installUrl.trim()) return;
    installing = true;
    installMsg = null;
    try {
      const result = await api.installPlugin(installUrl.trim());
      installMsg = { kind: 'success', text: `Installed: ${result.installed}` };
      installUrl = '';
      await load();
    } catch (err) {
      installMsg = { kind: 'error', text: err instanceof HubError ? err.message : String(err) };
    } finally {
      installing = false;
    }
  }

  function statusBadge(name: string): { label: string; kind: 'ok' | 'warn' | 'muted' } | null {
    const s = oauthStatus[name];
    if (!s) return null;
    if (!s.requires_oauth) return null;
    if (s.connected) return { label: 'Connected', kind: 'ok' };
    if (s.configured) return { label: 'Configured', kind: 'warn' };
    return { label: 'Needs setup', kind: 'muted' };
  }

  onMount(load);
</script>

<svelte:head>
  <title>Plugins · pdatahub</title>
</svelte:head>

<div class="plugins">
  <h1>Plugins</h1>

  <section class="install-section">
    <h2>Install from GitHub Releases</h2>
    <p class="dim">
      Paste a release URL (e.g.
      <code>https://github.com/pdatahub/pdatahub-plugin-google-calendar/releases/latest/download/&lt;plugin&gt;.tgz</code>)
      and click Install.
    </p>
    <form onsubmit={(e) => { e.preventDefault(); install(); }}>
      <input
        type="url"
        bind:value={installUrl}
        placeholder="https://github.com/pdatahub/&lt;plugin&gt;/releases/download/v0.1.0/&lt;plugin&gt;-0.1.0.tgz"
        disabled={installing}
      />
      <button class="btn btn-primary" type="submit" disabled={installing || !installUrl.trim()}>
        {installing ? 'Installing…' : 'Install'}
      </button>
    </form>
    {#if installMsg}
      <p class="msg" data-kind={installMsg.kind}>{installMsg.text}</p>
    {/if}
  </section>

  <section class="list-section">
    <h2>Installed ({byPlugin().length})</h2>
    {#if loading}
      <p class="dim">Loading…</p>
    {:else if error}
      <p class="danger">{error}</p>
    {:else if byPlugin().length === 0}
      <EmptyState
        title="No plugins installed"
        description="Install a plugin above to expose external services (Calendar, Gmail, Slack, …) to your AI agents."
      />
    {:else}
      {#each byPlugin() as [name, tools]}
        {@const badge = statusBadge(name)}
        <article class="plugin-card">
          <header>
            <h3>{name}</h3>
            <span class="count">{tools.length} tool{tools.length === 1 ? '' : 's'}</span>
            {#if badge}
              <span class="badge" data-kind={badge.kind}>{badge.label}</span>
            {/if}
            {#if oauthStatus[name]?.requires_oauth}
              <button
                type="button"
                class="btn btn-small"
                onclick={() => (oauthModalPlugin = name)}
              >
                {oauthStatus[name]?.connected ? 'Manage' : oauthStatus[name]?.configured ? 'Connect' : 'Setup'}
              </button>
            {/if}
          </header>
          <ul>
            {#each tools as tool}
              <li>
                <code>{tool.name}</code>
                {#if tool.scope}<span class="scope">{tool.scope}</span>{/if}
                {#if tool.description}<span class="desc">{tool.description}</span>{/if}
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    {/if}
  </section>
</div>

{#if oauthModalPlugin}
  <OAuthSetupModal
    pluginName={oauthModalPlugin}
    status={oauthStatus[oauthModalPlugin] ?? null}
    onClose={() => {
      oauthModalPlugin = null;
      load();
    }}
  />
{/if}

<style>
  .plugins { display: flex; flex-direction: column; gap: var(--space-6); }
  h1 { margin: 0; font-size: 28px; font-weight: 700; }
  h2 { margin: 0 0 var(--space-3); font-size: 18px; font-weight: 600; }
  h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .dim { color: var(--fg-dim); }
  .danger { color: var(--danger); }
  .install-section {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
  }
  .install-section form {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .msg {
    margin: var(--space-3) 0 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    font-size: 14px;
  }
  .msg[data-kind='success'] {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success);
  }
  .msg[data-kind='error'] {
    background: rgba(248, 113, 113, 0.15);
    color: var(--danger);
  }
  .plugin-card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-top: var(--space-3);
  }
  .plugin-card header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }
  .count { color: var(--fg-dim); font-size: 13px; }
  .badge {
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 12px;
    font-weight: 500;
  }
  .badge[data-kind='ok'] { background: rgba(74, 222, 128, 0.18); color: var(--success); }
  .badge[data-kind='warn'] { background: rgba(250, 204, 21, 0.18); color: #facc15; }
  .badge[data-kind='muted'] { background: var(--bg-elev-2); color: var(--fg-dim); }
  .btn-small {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 4px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    margin-left: auto;
  }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border-radius: var(--radius);
    font-size: 14px;
    flex-wrap: wrap;
  }
  .scope {
    padding: 2px 8px;
    background: var(--bg-elev-2);
    border-radius: var(--radius-pill);
    font-size: 12px;
    color: var(--fg-dim);
  }
  .desc { color: var(--fg-dim); font-size: 13px; flex: 1; min-width: 200px; }
</style>
