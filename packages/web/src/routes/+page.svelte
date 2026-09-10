<script lang="ts">
  import { onMount } from 'svelte';
  import { api, HubError } from '$lib/api';
  import { session } from '$lib/stores/session';
  import StatPill from '$lib/components/StatPill.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type {
    IdentityResponse,
    ListToolsResponse,
    ListAuditResponse,
  } from '$lib/types';

  let identity = $state<IdentityResponse | null>(null);
  let tools = $state<ListToolsResponse | null>(null);
  let recentAudit = $state<ListAuditResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [id, t, a] = await Promise.all([
        api.identity().catch(() => null),
        api.listTools().catch(() => ({ tools: [] })),
        api.listAudit({ limit: 5 }).catch(() => ({ entries: [], total: 0 })),
      ]);
      identity = id;
      tools = t;
      recentAudit = a;
      session.update((s) => ({ ...s, hubOnline: true }));
    } catch (err) {
      error = err instanceof HubError ? err.message : String(err);
      session.update((s) => ({ ...s, hubOnline: false }));
    } finally {
      loading = false;
    }
  });

  const installedPlugins = $derived(
    new Set(tools?.tools.filter((t) => !t.federated).map((t) => t.plugin) ?? []),
  );
</script>

<svelte:head>
  <title>Dashboard · pdatahub</title>
</svelte:head>

<div class="dashboard">
  <h1>Dashboard</h1>

  {#if loading}
    <p class="loading">Loading hub state…</p>
  {:else if error}
    <EmptyState
      title="Cannot reach hub"
      description={error}
    />
  {:else}
    <div class="stats">
      <StatPill
        label="Hub"
        value={identity?.hub_name ?? 'unnamed'}
        sub={identity?.fingerprint ? `fingerprint ${identity.fingerprint}` : 'identity not initialized'}
      />
      <StatPill
        label="Tools"
        value={tools?.tools.length ?? 0}
        sub={`${installedPlugins.size} plugin${installedPlugins.size === 1 ? '' : 's'} installed`}
      />
      <StatPill
        label="Audit rows"
        value={recentAudit?.total ?? 0}
        sub="lifetime"
      />
    </div>

    {#if installedPlugins.size === 0}
      <EmptyState
        title="No plugins installed yet"
        description="Install your first plugin to expose tools to AI agents. We recommend starting with Google Calendar or Gmail."
        actionLabel="Install a plugin"
        actionHref="/plugins"
      />
    {:else}
      <section class="card">
        <h2>Recent activity</h2>
        {#if !recentAudit || recentAudit.entries.length === 0}
          <p class="dim">No activity yet. Approve a tool call from your AI agent to see entries here.</p>
        {:else}
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Agent</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {#each recentAudit.entries as row}
                <tr>
                  <td>{new Date(row.ts).toLocaleString()}</td>
                  <td><code>{row.tool_name ?? '—'}</code></td>
                  <td><code>{row.agent_id}</code></td>
                  <td><span class="decision" data-decision={row.decision}>{row.decision}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          <a href="/audit" class="see-all">See all →</a>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .dashboard { display: flex; flex-direction: column; gap: var(--space-5); }
  h1 { margin: 0 0 var(--space-3); font-size: 28px; font-weight: 700; }
  .loading { color: var(--fg-dim); }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
  }
  section.card { display: flex; flex-direction: column; gap: var(--space-3); }
  h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .dim { color: var(--fg-dim); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: var(--space-2) var(--space-3); text-align: left; }
  thead { border-bottom: 1px solid var(--border); color: var(--fg-dim); font-size: 12px; text-transform: uppercase; }
  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: none; }
  .decision {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 12px;
    font-weight: 500;
    background: var(--bg-elev-2);
  }
  .decision[data-decision='approved'] { background: rgba(74, 222, 128, 0.15); color: var(--success); }
  .decision[data-decision='denied'] { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
  .decision[data-decision='error'] { background: rgba(250, 204, 21, 0.15); color: var(--warning); }
  .see-all { align-self: flex-start; font-size: 14px; }
</style>
