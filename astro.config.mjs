import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  site: 'https://adamlilienfeldt.com',
  // Playlist pages are link-only (noindex), so keep them out of the sitemap.
  integrations: [sitemap({ filter: (page) => !page.includes('/playlists/') })],
});
