import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	plugins: [
		sveltekit(),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'Alfajer',
				short_name: 'Alfajer',
				description: 'Fully anonymous, private, secret 1-to-1 calls. No accounts. No logs.',
				start_url: '/',
				display: 'standalone',
				orientation: 'portrait',
				background_color: '#0f172a',
				theme_color: '#0f172a',
				categories: ['social', 'communication'],
				icons: [
					{
						src: 'icon.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'any'
					},
					{
						src: 'icon.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,json,webmanifest}']
			}
		})
	]
});
