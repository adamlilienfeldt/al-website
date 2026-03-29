import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  output: 'static',
  site: isGitHubPages ? 'https://adamlilienfeldt.github.io' : 'https://adamlilienfeldt.com',
  base: isGitHubPages ? '/al-website' : '/',
  integrations: [sitemap()],
});
