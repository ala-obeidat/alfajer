# Cloudflare Pages Deployment

Instructions for deploying the Alfajer Web application (SvelteKit) to Cloudflare Pages.

## Build Settings

1. Connect your GitHub repository to Cloudflare Pages.
2. Select the **SvelteKit** framework preset.
3. Configure the build commands:
   - **Framework Preset**: SvelteKit
   - **Build command**: `npm run build` or `bun run build`
   - **Build output directory**: `.svelte-kit/cloudflare`
   - **Root directory**: `apps/web` (since this is a monorepo)

## Environment Variables

Ensure you set these environment variables in the Cloudflare Pages settings:

- `NODE_VERSION`: `20` (or `22`)
- `PUBLIC_SIGNALING_URL`: `wss://alaobeidat.com`

## Adapter Configuration

Ensure your `svelte.config.js` is using `@sveltejs/adapter-cloudflare` or `@sveltejs/adapter-auto` to properly build the Edge-compatible output for Cloudflare's network.
