<script lang="ts">
  import { onMount } from 'svelte';
  import { api, HubError } from '$lib/api';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import type { ListAuditResponse, AuditEntry } from '$lib/types';

  let audit = $state<ListAuditResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Filters
  let filterPlugin = $state('');
  let filterDecision = $state('');
  let limit = $state(50);
  let offset = $state(0);

  async function load() {
    loading = true;
    error = null;
    try {
      audit = await api.listAudit({
        limit,
        offset,
        ...(filterPlugin ? { plugin: filterPlugin } : {}),
        ...(filterDecision ? { decision: filterDecision } : {}),
      });
    } catch (err) {
      error = err instanceof HubError ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function next() {
    offset += limit;
    load();
  }

  function prev() {
    offset = Math.max(0, offset - limit);
    load();
  }

  function exportCsv() {
    if (!audit?.entries.length) return;
    const rows = audit.entries.map((e) => [
      e.ts, e.agent_id, e.plugin ?? '', e.tool_name ?? '', e.scope ?? '',
      e.decision, e.duration_ms ?? '', e.error ?? '',
    ]);
    const csv = [['timestamp', 'agent', 'plugin', 'tool', 'scope', 'decision', 'duration_ms', 'error'].join(',')]
      .concat(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onMount(load);

  $effect(() => {
    // Re-load when filters change
    filterPlugin; filterDecision; limit;
    offset = 0;
    load();
  });
</script>

<svelte:head>
  <title>Audit · pdatahub</title>
</svelte:head>

<div class="audit">
  <div class="header-row">
    <h1>Audit log</h1>
    {#if audit?.entries.length}
      <button class="btn" onclick={exportCsv}>Export CSV</button>
    {/if}
  </div>

  <div class="filters card">
    <label>
      <span>Plugin</span>
      <input bind:value={filterPlugin} placeholder="e.g. google-calendar" />
    </label>
    <label>
      <span>Decision</span>
      <select bind:value={filterDecision}>
        <option value="">all</option>
        <option value="approved">approved</option>
        <option value="denied">denied</option>
        <option value="error">error</option>
      </select>
    </label>
    <label>
      <span>Limit</span>
      <select bind:value={limit}>
        <option value={25}>25</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
    </label>
  </div>

  {#if loading}
    <p class="dim">Loading…</p>
  {:else if error}
    <p class="danger">{error}</p>
  {:else if !audit || audit.entries.length === 0}
    <EmptyState
      title="No audit entries"
      description="Once you approve or deny a tool call, it'll show up here."
    />
  {:else}
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Plugin</th>
            <th>Tool</th>
            <th>Scope</th>
            <th>Decision</th>
            <th>Duration</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {#each audit.entries as row (row.id)}
            <tr>
              <td>{new Date(row.ts).toLocaleString()}</td>
              <td><code>{row.agent_id}</code></td>
              <td>{row.plugin ?? '—'}</td>
              <td><code>{row.tool_name ?? '—'}</code></td>
              <td><code>{row.scope ?? '—'}</code></td>
              <td><span class="decision" data-decision={row.decision}>{row.decision}</span></td>
              <td>{row.duration_ms ?? '—'}{row.duration_ms !== null ? 'ms' : ''}</td>
              <td class="error-cell">{row.error ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button class="btn" onclick={prev} disabled={offset === 0}>← Newer</button>
      <span>Showing {offset + 1}–{Math.min(offset + limit, audit.total)} of {audit.total}</span>
      <button class="btn" onclick={next} disabled={offset + limit >= audit.total}>Older →</button>
    </div>
  {/if}
</div>

<style>
  .audit { display: flex; flex-direction: column; gap: var(--space-4); }
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h1 { margin: 0; font-size: 28px; font-weight: 700; }
  .dim { color: var(--fg-dim); }
  .danger { color: var(--danger); }
  .filters {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    align-items: end;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .filters span { color: var(--fg-dim); }
  .filters input, .filters select { min-width: 180px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: var(--space-2) var(--space-3); text-align: left; }
  thead { border-bottom: 1px solid var(--border); color: var(--fg-dim); font-size: 11px; text-transform: uppercase; }
  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: var(--bg-elev-2); }
  .decision {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .decision[data-decision='approved'] { background: rgba(74, 222, 128, 0.15); color: var(--success); }
  .decision[data-decision='denied'] { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
  .decision[data-decision='error'] { background: rgba(250, 204, 21, 0.15); color: var(--warning); }
  .error-cell { color: var(--danger); max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3);
    color: var(--fg-dim);
    font-size: 14px;
  }
</style>
