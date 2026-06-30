#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

// Covers render in a ~330px grid cell (≤660px @2x), so cap the long edge at 660px.
const MAX_EDGE = 660;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIC_JSON = join(__dirname, 'src/data/music.json');
// Covers live in src/assets so astro:assets can optimize them at build time.
// The `cover` field keeps its historical "/images/<file>" form as a logical
// key; resolveCover() in src/lib/covers.ts matches on the bare filename.
const IMAGES_DIR = join(__dirname, 'src/assets/covers');

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Odesli platform key -> our stable service key, in display order. Only these
// are persisted; anything else Odesli returns is dropped.
const PLATFORMS = [
  ['spotify', 'spotify'],
  ['appleMusic', 'appleMusic'],
  ['youtubeMusic', 'youtubeMusic'],
  ['youtube', 'youtube'],
  ['tidal', 'tidal'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One Odesli lookup returns both the cover thumbnail and the per-service links.
// Odesli's free tier is ~10 req/min, so retry on 429 with backoff.
async function fetchOdesli(link) {
  const url = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(link)}`;
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) break;
    const wait = 2000 * (attempt + 1);
    console.log(`    rate-limited, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  if (!res.ok) throw new Error(`Odesli API error ${res.status} for ${link}`);
  const data = await res.json();
  const entity = Object.values(data.entitiesByUniqueId)[0];

  const services = {};
  for (const [odesliKey, ourKey] of PLATFORMS) {
    const url = data.linksByPlatform?.[odesliKey]?.url;
    if (url) services[ourKey] = url;
  }

  return { thumbnailUrl: entity?.thumbnailUrl, services };
}

async function downloadImage(imageUrl, destPath) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download ${imageUrl}`);
  const input = Buffer.from(await res.arrayBuffer());
  const output = await sharp(input)
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  writeFileSync(destPath, output);
}

async function main() {
  // --force re-fetches service links even when already present (covers are
  // still skipped if on disk). Used to enrich thin/partial service data.
  const force = process.argv.includes('--force');
  // Odesli free tier rate-limits aggressively; default 7s, --force uses 12s.
  const throttleMs = force ? 12000 : 7000;

  const releases = JSON.parse(readFileSync(MUSIC_JSON, 'utf-8'));
  let changed = false;

  for (const release of releases) {
    const needsCover = !release.cover;
    const needsServices =
      force || !release.services || Object.keys(release.services).length === 0;
    if (!needsCover && !needsServices) continue;

    const apiUrl = release.spotify || release.link;
    if (!apiUrl) continue;

    const slug = slugify(`${release.artist}-${release.title}`);
    const filename = `${slug}.jpg`;
    const localPath = `/images/${filename}`;
    const destPath = join(IMAGES_DIR, filename);

    // Cover already on disk — set the field without re-hitting Odesli, but
    // still fall through to fetch services if those are missing.
    if (needsCover && existsSync(destPath)) {
      console.log(`  exists: ${filename}, setting cover`);
      release.cover = localPath;
      changed = true;
    }

    const stillNeedsCover = !release.cover;
    if (!stillNeedsCover && !needsServices) continue;

    console.log(`  fetching: ${release.artist} — ${release.title}`);
    try {
      const { thumbnailUrl, services } = await fetchOdesli(apiUrl);

      if (stillNeedsCover) {
        if (thumbnailUrl) {
          await downloadImage(thumbnailUrl, destPath);
          release.cover = localPath;
          changed = true;
          console.log(`    saved: ${filename}`);
        } else {
          console.log(`    no thumbnail found`);
        }
      }

      // On --force, never overwrite richer existing data with a thinner
      // (e.g. partial/transient) response.
      const existingCount = Object.keys(release.services || {}).length;
      if (Object.keys(services).length > 0 && Object.keys(services).length >= existingCount) {
        release.services = services;
        changed = true;
        console.log(`    services: ${Object.keys(services).join(', ')}`);
      } else if (Object.keys(services).length) {
        console.log(`    keeping existing (${existingCount}) over thinner (${Object.keys(services).length})`);
      }
    } catch (err) {
      console.error(`    error: ${err.message}`);
    }

    // Stay under Odesli's free-tier rate limit (~10 req/min).
    await sleep(throttleMs);
  }

  if (changed) {
    writeFileSync(MUSIC_JSON, JSON.stringify(releases, null, 2) + '\n');
    console.log('updated music.json');
  } else {
    console.log('nothing to fetch');
  }
}

main();
