#!/usr/bin/env node

// Create or refresh a link-only playlist page from Spotify track links:
//
//   npm run playlist:add -- <slug> <spotify-track-url> [<spotify-track-url> ...]
//
// Writes src/data/playlists/<slug>.json and downloads covers to
// src/assets/playlists/, so the site build never calls an external API.
// Re-running with the same slug keeps the title, description and
// spotifyPlaylistUrl already in the file and rebuilds the track list.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchOdesli, fetchAppleMusic, downloadImage, sleep } from './fetch-covers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'src/data/playlists');
const COVERS_DIR = join(__dirname, 'src/assets/playlists');

const [slug, ...urls] = process.argv.slice(2);
if (!slug || !/^[a-z0-9-]+$/.test(slug) || urls.length === 0) {
  console.error('usage: npm run playlist:add -- <slug> <spotify-track-url> [...]');
  console.error('slug: lowercase letters, digits and dashes');
  process.exit(1);
}

// Track ids in the order given, duplicates dropped.
const ids = [];
for (const url of urls) {
  const m = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
  if (!m) {
    console.error(`not a spotify track link: ${url}`);
    process.exit(1);
  }
  if (ids.includes(m[1])) console.log(`  skipping duplicate: ${m[1]}`);
  else ids.push(m[1]);
}

// Odesli doesn't know durations; the Spotify track page has them in seconds.
async function spotifyDuration(id) {
  try {
    const res = await fetch(`https://open.spotify.com/track/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const m = (await res.text()).match(/<meta name="music:duration" content="(\d+)"/);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

const file = join(DATA_DIR, `${slug}.json`);
const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(COVERS_DIR, { recursive: true });

const tracks = [];
for (const id of ids) {
  const spotify = `https://open.spotify.com/track/${id}`;
  console.log(`  fetching: ${spotify}`);
  const odesli = await fetchOdesli(spotify);
  const services = { ...odesli.services, spotify };

  // Odesli misses Apple for many small releases; iTunes search usually has it.
  if (!services.appleMusic) {
    const apple = await fetchAppleMusic(odesli.artistName, odesli.title, 'single');
    if (apple) services.appleMusic = apple;
  }

  const cover = `${id}.jpg`;
  if (odesli.thumbnailUrl && !existsSync(join(COVERS_DIR, cover))) {
    await downloadImage(odesli.thumbnailUrl, join(COVERS_DIR, cover));
  }

  const track = {
    title: odesli.title,
    artist: odesli.artistName,
    duration: await spotifyDuration(id),
    cover,
    songLink: odesli.pageUrl || `https://song.link/s/${id}`,
    services,
  };
  const missing = ['appleMusic', 'tidal'].filter((k) => !services[k]);
  console.log(`    ${track.artist} — ${track.title}${missing.length ? ` (no ${missing.join(', ')}: song.link fallback)` : ''}`);
  tracks.push(track);

  // Polite delay between page scrapes.
  await sleep(800);
}

const playlist = {
  title: existing.title || slug.replace(/-/g, ' '),
  description: existing.description || '',
  spotifyPlaylistUrl: existing.spotifyPlaylistUrl || '',
  tracks,
};
writeFileSync(file, JSON.stringify(playlist, null, 2) + '\n');
console.log(`wrote ${file}`);
console.log(`page: /playlists/${slug} (edit title/description in the json)`);
