<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { api, HubError } from '$lib/api';
  import { getApiToken, session } from '$lib/stores/session';
  import Emptystate from '$lib/components/EmptyState.svelte';
  import type { ApprovalRequest } from '$lib/types';

  let pending = $state<ApprovalRequest[]>([]);
  let history = $state<Array<ApprovalRequest & { decision: string; decidedAt: string }>>([]);
  let wsState = $state<'connecting' | 'open' | 'closed' | 'error'>('closed');
  let error = $state<string | null>(null);
  let ws: WebSocket | null = null;

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/approval-stream`;
    const token = getApiToken();
    wsState = 'connecting';
    ws = new WebSocket(url, token ? [`bearer.${token}`] : undefined);

    ws.addEventListener('open', () => {
      wsState = 'open';
      // Auto-approver for dev: send approve after 30s if no user response.
      // For now: do nothing — user must click.
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'approval_request' && typeof msg.request_id === 'string') {
          pending = [...pending, msg as ApprovalRequest];
        }
      } catch {
        // ignore malformed
      }
    });

    ws.addEventListener('close', () => {
      wsState = 'closed';
    });

    ws.addEventListener('error', () => {
      wsState = 'error';
      error = 'WebSocket connection failed';
    });
  }

  function approve(req: ApprovalRequest) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'approval_decided',
      request_id: req.request_id,
      decision: 'approved',
    }));
    history = [...history, { ...req, decision: 'approved', decidedAt: new Date().toISOString() }];
    pending = pending.filter((r) => r.request_id !== req.request_id);
  }

  function deny(req: ApprovalRequest) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'approval_decided',
      request_id: req.request_id,
      decision: 'denied',
    }));
    history = [...history, { ...req, decision: 'denied', decidedAt: new Date().toISOString() }];
    pending = pending.filter((r) => r.request_id !== req.request_id);
  }

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    ws?.close();
  });
</script>

<svelte:head>
  <title>Approval · pdatahub</title>
</svelte:head>

<div class="approval">
  <h1>Approval</h1>
  <p class="dim">
    Status: <strong>{wsState}</strong>
    {#if error}— <span class="danger">{error}</span>{/if}
  </p>

  <section class="pending-section">
    <h2>Pending requests ({pending.length})</h2>
    {#if pending.length === 0}
      <Emptystate
        title="No pending approvals"
        description="When an AI agent requests a tool call, it'll appear here for you to allow or deny."
      />
    {:else}
      {#each pending as req (req.request_id)}
        <article class="approval-card">
          <div class="meta">
            <span class="plugin">{req.plugin}</span>
            <code>{req.tool_name}</code>
          </div>
          {#if req.justification}
            <p class="justification">"{req.justification}"</p>
          {/if}
          <div class="meta-secondary">
            <span>Agent: <code>{req.agent_id}</code></span>
            <span>Scope: <code>{req.scope}</code></span>
          </div>
          <div class="actions">
            <button class="btn btn-danger" onclick={() => deny(req)}>Deny</button>
            <button class="btn btn-primary" onclick={() => approve(req)}>Allow</button>
          </div>
        </article>
      {/each}
    {/if}
  </section>

  {#if history.length > 0}
    <section class="history-section">
      <h2>Recent decisions ({history.length})</h2>
      <ul>
        {#each history.slice(-20).reverse() as h}
          <li>
            <span class="decision" data-decision={h.decision}>{h.decision}</span>
            <code>{h.tool_name}</code>
            <span class="dim">{new Date(h.decidedAt).toLocaleTimeString()}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .approval { display: flex; flex-direction: column; gap: var(--space-5); }
  h1 { margin: 0; font-size: 28px; font-weight: 700; }
  h2 { margin: 0 0 var(--space-3); font-size: 18px; font-weight: 600; }
  .dim { color: var(--fg-dim); }
  .danger { color: var(--danger); }
  .approval-card {
    background: var(--bg-elev);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .plugin {
    padding: 2px 8px;
    background: var(--accent);
    color: var(--bg);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
  }
  .justification {
    margin: 0;
    padding: var(--space-3);
    background: var(--bg);
    border-radius: var(--radius);
    font-style: italic;
    color: var(--fg-dim);
  }
  .meta-secondary {
    display: flex;
    gap: var(--space-4);
    font-size: 13px;
    color: var(--fg-dim);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
  .history-section ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .history-section li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .decision {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 500;
  }
  .decision[data-decision='approved'] { background: rgba(74, 222, 128, 0.15); color: var(--success); }
  .decision[data-decision='denied'] { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
</style>
