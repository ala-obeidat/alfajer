<script lang="ts">
  import '../lib/i18n';
  import '../app.css';
  import { onMount } from 'svelte';

  let { children } = $props();

  onMount(async () => {
    // We import dynamically to avoid SSR issues
    const pwaModule = await import('virtual:pwa-register');
    const registerSW = pwaModule.registerSW;
    if (registerSW) {
      registerSW({
        immediate: true
      });
    }
  });
</script>

<svelte:head>
  <title>Alfajer</title>
</svelte:head>

<main class="app-container">
  {@render children()}
</main>
