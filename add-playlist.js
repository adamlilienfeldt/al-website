#!/usr/bin/env node

// Create or refresh a link-only playlist page from Spotify track links:
//
//   npm run playlist:add -- <slug> <spotify-track-url> [<spotify-track-url> ...]
//
// Without links it reads them from the clipboard (macOS), so you can select
// tracks in the Spotify app, press Cmd+C and run `npm run playlist:add -- <slug>`.
//
// Writes src/data/playlists/<slug>.json and downloads covers to
// src/assets/playlists/, so the site build never calls an external API.
// Re-running with the same slug keeps the title, description and
// spotifyPlaylistUrl already in the file and rebuilds the track list.
// The admin console (npm run admin) uses the helpers exported here.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fetchOdesli, fetchAppleMusic, downloadImage, sleep } from './fetch-covers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'src/data/playlists');
export const PLAYLIST_COVERS_DIR = join(__dirname, 'src/assets/playlists');
export const SLUG_RE = /^[a-z0-9-]+$/;

// Spotify track ids in the order given, duplicates dropped, plus anything
// that isn't a track link. Accepts one link per line (Spotify's Cmd+C) or
// space separated.
export function parseTrackIds(text) {
  const ids = [];
  const bad = [];
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const m = word.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/);
    if (!m) bad.push(word);
    else if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return { ids, bad };
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

// Look up one Spotify track: links on other services, duration, cover
// (downloaded once into PLAYLIST_COVERS_DIR). Throws if song.link fails.
export async function resolveTrack(id) {
  const spotify = `https://open.spotify.com/track/${id}`;
  const odesli = await fetchOdesli(spotify);
  const services = { ...odesli.services, spotify };

  // Odesli misses Apple for many small releases; iTunes search usually has it.
  if (!services.appleMusic) {
    const apple = await fetchAppleMusic(odesli.artistName, odesli.title, 'single');
    if (apple) services.appleMusic = apple;
  }

  const cover = `${id}.jpg`;
  if (odesli.thumbnailUrl && !existsSync(join(PLAYLIST_COVERS_DIR, cover))) {
    mkdirSync(PLAYLIST_COVERS_DIR, { recursive: true });
    await downloadImage(odesli.thumbnailUrl, join(PLAYLIST_COVERS_DIR, cover));
  }

  return {
    title: odesli.title,
    artist: odesli.artistName,
    duration: await spotifyDuration(id),
    cover,
    songLink: odesli.pageUrl || `https://song.link/s/${id}`,
    services,
  };
}

export function listPlaylists() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ slug: f.slice(0, -5), ...readPlaylist(f.slice(0, -5)) }));
}

export function readPlaylist(slug) {
  const file = join(DATA_DIR, `${slug}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

export function writePlaylist(slug, playlist) {
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug: ${slug}`);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, `${slug}.json`), JSON.stringify(playlist, null, 2) + '\n');
}

async function main() {
  const [slug, ...args] = process.argv.slice(2);
  // From args, or the clipboard when none are given.
  const { ids, bad } = parseTrackIds(args.length ? args.join(' ') : execSync('pbpaste', { encoding: 'utf-8' }));
  if (!slug || !SLUG_RE.test(slug) || ids.length === 0 || bad.length) {
    for (const b of bad) console.error(`not a spotify track link: ${b}`);
    console.error('usage: npm run playlist:add -- <slug> [<spotify-track-url> ...]');
    console.error('slug: lowercase letters, digits and dashes');
    console.error('no links given: copy tracks in Spotify (Cmd+C) first');
    process.exit(1);
  }

  const tracks = [];
  for (const id of ids) {
    console.log(`  fetching: https://open.spotify.com/track/${id}`);
    const track = await resolveTrack(id);
    const missing = ['appleMusic', 'tidal'].filter((k) => !track.services[k]);
    console.log(`    ${track.artist} — ${track.title}${missing.length ? ` (no ${missing.join(', ')}: song.link fallback)` : ''}`);
    tracks.push(track);
    // Polite delay between page scrapes.
    await sleep(800);
  }

  const existing = readPlaylist(slug) || {};
  writePlaylist(slug, {
    title: existing.title || slug.replace(/-/g, ' '),
    description: existing.description || '',
    spotifyPlaylistUrl: existing.spotifyPlaylistUrl || '',
    tracks,
  });
  console.log(`wrote src/data/playlists/${slug}.json`);
  console.log(`page: /playlists/${slug} (edit title/description in the json)`);
}

// Run only as a script; admin.js imports the helpers above.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
