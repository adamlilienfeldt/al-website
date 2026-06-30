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
// are persisted; anything else Odesli lists is dropped.
const PLATFORMS = [
  ['spotify', 'spotify'],
  ['appleMusic', 'appleMusic'],
  ['youtubeMusic', 'youtubeMusic'],
  ['youtube', 'youtube'],
  ['tidal', 'tidal'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recursively find the first object key in a parsed JSON tree.
function deepFind(obj, key) {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = deepFind(v, key);
      if (r !== undefined) return r;
    }
  } else if (obj && typeof obj === 'object') {
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = deepFind(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

// Odesli often fails to map Apple Music for smaller releases (the platform is
// listed but empty). The free iTunes Search API resolves most of them by
// artist+title. Returns a music.apple.com URL or null.
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function itunesSearch(artist, title, entity) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=8`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).results || [];
  } catch {
    return [];
  }
}

function matchApple(results, artist, title) {
  const na = normKey(artist);
  const key = normKey(title).slice(0, 12);
  for (const r of results) {
    const ra = normKey(r.artistName);
    if (!(ra === na || na.includes(ra) || ra.includes(na))) continue;
    const rt = normKey(r.collectionName) + normKey(r.trackName);
    if (key && rt.includes(key)) {
      const link = r.trackViewUrl || r.collectionViewUrl;
      if (link) return link.split('?')[0];
    }
  }
  return null;
}

async function fetchAppleMusic(artist, title, type) {
  // EPs and albums are collections on Apple; only true singles are 'song'.
  const entity = type === 'single' ? 'song' : 'album';
  // Try the full title, then the part before a "/" (split-single titles).
  const titles = [title];
  if (title.includes('/')) titles.push(title.split('/')[0].trim());
  for (const t of titles) {
    const link = matchApple(await itunesSearch(artist, t, entity), artist, t);
    if (link) return link;
  }
  return null;
}

// Scrape the public song.link / album.link page rather than the API. The page
// embeds the full link set (incl. YouTube/Apple) in __NEXT_DATA__ and isn't
// subject to the API's aggressive 429 throttle — it also resolves Odesli's own
// shortlinks, which the API rejects with 400.
async function fetchOdesli(link) {
  // Odesli's own short pages (song.link/album.link) embed __NEXT_DATA__
  // directly. A raw Spotify track/album URL is mapped to the equivalent
  // song.link /s/ (or album.link) page, which carries the same data.
  // (song.link/?url= just bounces to the odesli.co homepage — no page data.)
  let pageUrl = link;
  const sp = link.match(/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]+)/);
  if (sp) {
    pageUrl = sp[1] === 'album'
      ? `https://album.link/s/${sp[2]}`
      : `https://song.link/s/${sp[2]}`;
  }

  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`page fetch ${res.status} for ${link}`);
  const html = await res.text();

  const m = html.match(/id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error(`no __NEXT_DATA__ in page for ${link}`);
  const data = JSON.parse(m[1]);

  const pageData = deepFind(data, 'pageData');
  const sections = pageData?.sections || [];
  const listen = sections.find((s) => s?.displayName === 'Listen');
  const byPlatform = {};
  for (const ln of listen?.links || []) {
    if (ln?.platform && ln?.url) byPlatform[ln.platform] = ln.url;
  }

  const services = {};
  for (const [odesliKey, ourKey] of PLATFORMS) {
    if (byPlatform[odesliKey]) services[ourKey] = byPlatform[odesliKey];
  }

  // Thumbnail lives on the first (header) section.
  const thumbnailUrl = sections.find((s) => s?.thumbnailUrl)?.thumbnailUrl;

  return { thumbnailUrl, services };
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
  // Page scrape isn't API-throttled; a small polite delay is plenty.
  const throttleMs = 800;

  const releases = JSON.parse(readFileSync(MUSIC_JSON, 'utf-8'));
  let changed = false;

  for (const release of releases) {
    const needsCover = !release.cover;
    const needsServices =
      force || !release.services || Object.keys(release.services).length === 0;
    if (!needsCover && !needsServices) continue;

    const apiUrl = release.link;
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

      // On --force, never drop a platform we already have. Merge the fresh
      // response over the existing services so re-fetches only ever add/refresh
      // keys, never lose one to a partial/transient response.
      if (Object.keys(services).length > 0) {
        const existing = release.services || {};
        const merged = { ...existing, ...services };
        const added = Object.keys(merged).filter((k) => !(k in existing));
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          release.services = merged;
          changed = true;
          console.log(`    services: ${Object.keys(merged).join(', ')}${added.length ? ` (+${added.join(', ')})` : ''}`);
        }
      }

      // Apple Music fallback: Odesli misses it for many small releases, but the
      // iTunes Search API usually has it. Only fill if still absent.
      if (!release.services?.appleMusic) {
        const apple = await fetchAppleMusic(release.artist, release.title, release.type);
        if (apple) {
          release.services = { ...(release.services || {}), appleMusic: apple };
          changed = true;
          console.log(`    apple (itunes): ${apple}`);
        }
      }
    } catch (err) {
      console.error(`    error: ${err.message}`);
    }

    // Polite delay between page scrapes / iTunes lookups.
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
