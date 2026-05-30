#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

// Covers render in a ~330px grid cell (≤660px @2x), so cap the long edge at 660px.
const MAX_EDGE = 660;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIC_JSON = join(__dirname, 'src/data/music.json');
const IMAGES_DIR = join(__dirname, 'public/images');

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function fetchThumbnailUrl(link) {
  const url = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(link)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odesli API error ${res.status} for ${link}`);
  const data = await res.json();
  const entity = Object.values(data.entitiesByUniqueId)[0];
  return entity?.thumbnailUrl;
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
  const releases = JSON.parse(readFileSync(MUSIC_JSON, 'utf-8'));
  let changed = false;

  for (const release of releases) {
    if (release.cover) continue;
    const apiUrl = release.spotify || release.link;
    if (!apiUrl) continue;

    const slug = slugify(`${release.artist}-${release.title}`);
    const filename = `${slug}.jpg`;
    const localPath = `/images/${filename}`;
    const destPath = join(IMAGES_DIR, filename);

    if (existsSync(destPath)) {
      console.log(`  exists: ${filename}, setting cover`);
      release.cover = localPath;
      changed = true;
      continue;
    }

    console.log(`  fetching: ${release.artist} — ${release.title}`);
    try {
      const thumbUrl = await fetchThumbnailUrl(apiUrl);
      if (!thumbUrl) {
        console.log(`    no thumbnail found, skipping`);
        continue;
      }
      await downloadImage(thumbUrl, destPath);
      release.cover = localPath;
      changed = true;
      console.log(`    saved: ${filename}`);
    } catch (err) {
      console.error(`    error: ${err.message}`);
    }
  }

  if (changed) {
    writeFileSync(MUSIC_JSON, JSON.stringify(releases, null, 2) + '\n');
    console.log('updated music.json');
  } else {
    console.log('nothing to fetch');
  }
}

main();
