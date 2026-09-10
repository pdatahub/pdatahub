<script lang="ts">
  interface Props {
    title: string;
    description?: string;
    actionLabel?: string;
    actionHref?: string;
  }
  let { title, description, actionLabel, actionHref }: Props = $props();
</script>

<div class="empty-state">
  <div class="icon">·</div>
  <h3>{title}</h3>
  {#if description}<p>{description}</p>{/if}
  {#if actionLabel && actionHref}
    <a class="btn btn-primary" href={actionHref}>{actionLabel}</a>
  {/if}
</div>

<style>
  .empty-state {
    text-align: center;
    padding: var(--space-7) var(--space-5);
    background: var(--bg-elev);
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }
  .icon {
    font-size: 48px;
    color: var(--fg-mute);
    line-height: 1;
  }
  h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--fg-dim);
    max-width: 480px;
  }
</style>
