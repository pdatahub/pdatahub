<script lang="ts">
  interface Props {
    label: string;
    value: string | number;
    sub?: string;
    accent?: 'default' | 'success' | 'warning' | 'danger';
  }
  let { label, value, sub, accent = 'default' }: Props = $props();
</script>

<div class="stat-pill" data-accent={accent}>
  <div class="label">{label}</div>
  <div class="value">{value}</div>
  {#if sub}
    <div class="sub">{sub}</div>
  {/if}
</div>

<style>
  .stat-pill {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .label {
    font-size: 12px;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .value {
    font-size: 28px;
    font-weight: 700;
    font-feature-settings: 'tnum';
  }
  .sub {
    font-size: 13px;
    color: var(--fg-mute);
  }
  .stat-pill[data-accent='success'] .value { color: var(--success); }
  .stat-pill[data-accent='warning'] .value { color: var(--warning); }
  .stat-pill[data-accent='danger'] .value { color: var(--danger); }
</style>
