<script lang="ts">
  import { session } from '../stores/session';
</script>

<div class="status" data-online={$session.hubOnline}>
  <span class="dot"></span>
  <span class="label">{$session.hubOnline ? 'Connected' : 'Offline'}</span>
</div>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    font-size: 13px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger);
    box-shadow: 0 0 6px var(--danger);
  }
  .status[data-online='true'] .dot {
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
  }
  .label {
    color: var(--fg-dim);
    font-weight: 500;
  }
</style>
