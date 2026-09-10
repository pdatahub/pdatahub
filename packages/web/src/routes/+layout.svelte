<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { session } from '$lib/stores/session';
  import { api } from '$lib/api';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';

  let { children } = $props();

  onMount(async () => {
    try {
      await api.health();
      session.update((s) => ({ ...s, hubOnline: true }));
    } catch {
      session.update((s) => ({ ...s, hubOnline: false }));
    }
  });

  const nav = [
    { href: '/', label: 'Dashboard' },
    { href: '/approval', label: 'Approval' },
    { href: '/plugins', label: 'Plugins' },
    { href: '/audit', label: 'Audit' },
    { href: '/settings', label: 'Settings' },
  ];
</script>

<header>
  <div class="header-inner">
    <a href="/" class="logo">pdatahub</a>
    <nav>
      {#each nav as item}
        <a
          href={item.href}
          class="nav-link"
          class:active={$page.url.pathname === item.href || ($page.url.pathname.startsWith(item.href) && item.href !== '/')}
        >
          {item.label}
        </a>
      {/each}
    </nav>
    <ConnectionStatus />
  </div>
</header>

<main>
  {@render children?.()}
</main>

<footer>
  <span>pdatahub · <a href="https://github.com/pdatahub/pdatahub">GitHub</a> · <a href="/docs">Docs</a></span>
</footer>

<style>
  header {
    border-bottom: 1px solid var(--border);
    background: rgba(15, 23, 42, 0.9);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .header-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--space-3) var(--space-5);
    display: flex;
    align-items: center;
    gap: var(--space-6);
  }
  .logo {
    font-weight: 700;
    font-size: 18px;
    color: var(--accent);
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: var(--space-2);
    flex: 1;
  }
  .nav-link {
    padding: 6px 12px;
    color: var(--fg-dim);
    border-radius: var(--radius);
    font-size: 14px;
    transition: all 0.15s;
    text-decoration: none;
  }
  .nav-link:hover {
    color: var(--fg);
    background: var(--bg-elev);
  }
  .nav-link.active {
    color: var(--accent);
    background: var(--bg-elev);
  }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
    min-height: calc(100vh - 130px);
  }
  footer {
    border-top: 1px solid var(--border);
    padding: var(--space-4);
    text-align: center;
    color: var(--fg-mute);
    font-size: 13px;
  }
  footer a {
    color: var(--fg-dim);
  }
</style>
