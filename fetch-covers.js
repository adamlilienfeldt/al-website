#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, basename } from 'path';
import sharp from 'sharp';
import { slugify } from './lib/slug.js';

// Stored originals, not what visitors download: astro:assets derives the
// delivered sizes at build time. The popup shows covers at up to 440px, so
// Retina needs ~900px; keep headroom. Mirrors MAX_EDGE in admin.js.
const MAX_EDGE = 1400;
// Apple serves artwork at any size we ask for; Spotify (Odesli's thumbnail)
// tops out at 640px. So Apple is the preferred cover source.
const APPLE_ARTWORK_EDGE = 1400;
// Film posters render up to half the page width, so they get a bigger cap.
const FILM_MAX_EDGE = 1280;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIC_JSON = join(__dirname, 'src/data/music.json');
const FILM_JSON = join(__dirname, 'src/data/film.json');
// Covers live in src/assets so astro:assets can optimize them at build time.
// The `cover` field keeps its historical "/images/<file>" form as a logical
// key; resolveCover() in src/lib/covers.ts matches on the bare filename.
const IMAGES_DIR = join(__dirname, 'src/assets/covers');

// Odesli platform key -> our stable service key, in display order. Only these
// are persisted; anything else Odesli lists is dropped.
const PLATFORMS = [
  ['spotify', 'spotify'],
  ['appleMusic', 'appleMusic'],
  ['youtubeMusic', 'youtubeMusic'],
  ['youtube', 'youtube'],
  ['tidal', 'tidal'],
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (!link) continue;
      // Keep only ?i=<track>: for a song it points the page at that track,
      // which matters when Apple files it on an EP or album, not a single.
      const u = new URL(link);
      const track = u.searchParams.get('i');
      return `${u.origin}${u.pathname}${track ? `?i=${track}` : ''}`;
    }
  }
  return null;
}

export async function fetchAppleMusic(artist, title, type) {
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

// Artwork for the release behind an Apple Music URL, looked up by its album
// id, at APPLE_ARTWORK_EDGE. Null if unavailable, or if Apple files the track
// under a different release (e.g. a single that only exists there as an EP
// track), whose cover would be the wrong one.
async function appleArtwork(appleUrl, title) {
  const m = String(appleUrl || '').match(/music\.apple\.com\/([a-z]{2})\/album\/[^/]+\/(\d+)/);
  if (!m) return null;
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${m[2]}&country=${m[1]}`);
    if (!res.ok) return null;
    const release = (await res.json()).results?.[0];
    const key = normKey(title).slice(0, 12);
    if (!release || !normKey(release.collectionName).includes(key)) return null;
    const art = release.artworkUrl100;
    return art ? art.replace(/\/\d+x\d+bb\.\w+$/, `/${APPLE_ARTWORK_EDGE}x${APPLE_ARTWORK_EDGE}bb.jpg`) : null;
  } catch {
    return null;
  }
}

// Scrape the public song.link / album.link page rather than the API. The page
// embeds the full link set (incl. YouTube/Apple) in __NEXT_DATA__ and isn't
// subject to the API's aggressive 429 throttle — it also resolves Odesli's own
// shortlinks, which the API rejects with 400.
export async function fetchOdesli(link) {
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

  // Thumbnail, title and artist live on the first (header) section.
  const header = sections.find((s) => s?.thumbnailUrl) || {};

  return {
    thumbnailUrl: header.thumbnailUrl,
    title: header.title,
    artistName: header.artistName,
    pageUrl: pageData?.pageUrl,
    services,
  };
}

// Download, cap at maxEdge and save as JPEG. With onlyIfLarger, keep the file
// already on disk unless the new image is wider (so a refresh never downgrades
// a hand-picked or bigger cover). Returns whether it wrote the file.
export async function downloadImage(imageUrl, destPath, maxEdge = MAX_EDGE, { onlyIfLarger = false } = {}) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download ${imageUrl}`);
  const input = Buffer.from(await res.arrayBuffer());
  if (onlyIfLarger && existsSync(destPath)) {
    const [fresh, current] = await Promise.all([sharp(input).metadata(), sharp(destPath).metadata()]);
    if (fresh.width <= current.width) return false;
  }
  // High quality: astro:assets re-encodes for delivery, so this is not the
  // last compression pass.
  const output = await sharp(input)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  writeFileSync(destPath, output);
  return true;
}

// Video film cards don't load the Vimeo iframe until the visitor clicks play,
// so the poster is what they see until then — a video entry without a cover
// renders as a black card. Pull Vimeo's own thumbnail for any that lack one.
async function fetchFilmPosters() {
  const films = JSON.parse(readFileSync(FILM_JSON, 'utf-8'));
  let changed = false;

  for (const film of films) {
    if (!film.vimeo_id || film.cover) continue;

    const filename = `${slugify(film.title)}.jpg`;
    const localPath = `/images/${filename}`;
    const destPath = join(IMAGES_DIR, filename);
    console.log(`film: ${film.title}`);

    if (existsSync(destPath)) {
      console.log(`    exists: ${filename}, setting cover`);
      film.cover = localPath;
      changed = true;
      continue;
    }

    try {
      const api = `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${film.vimeo_id}&width=1280`;
      const res = await fetch(api);
      if (!res.ok) throw new Error(`oembed ${res.status}`);
      const { thumbnail_url: thumb } = await res.json();
      if (!thumb) throw new Error('no thumbnail_url');

      await downloadImage(thumb, destPath, FILM_MAX_EDGE);
      film.cover = localPath;
      changed = true;
      console.log(`    saved: ${filename}`);
    } catch (err) {
      console.error(`    error: ${err.message}`);
    }
  }

  if (changed) {
    writeFileSync(FILM_JSON, JSON.stringify(films, null, 2) + '\n');
    console.log('updated film.json');
  }
}

async function main() {
  // --force re-fetches service links even when already present.
  // --covers re-downloads existing covers from the best source, replacing a
  // file only when the new image is bigger.
  const force = process.argv.includes('--force');
  const refreshCovers = process.argv.includes('--covers');
  // Page scrape isn't API-throttled; a small polite delay is plenty.
  const throttleMs = 800;

  const releases = JSON.parse(readFileSync(MUSIC_JSON, 'utf-8'));
  let changed = false;

  for (const release of releases) {
    const needsServices =
      force || !release.services || Object.keys(release.services).length === 0;
    if (!refreshCovers && release.cover && !needsServices) continue;
    if (!release.link) continue;

    // A refreshed cover keeps its current filename; new ones use the slug.
    const filename = release.cover
      ? basename(release.cover)
      : `${slugify(`${release.artist}-${release.title}`)}.jpg`;
    const localPath = `/images/${filename}`;
    const destPath = join(IMAGES_DIR, filename);

    // Cover already on disk: set the field without downloading again.
    if (!release.cover && !refreshCovers && existsSync(destPath)) {
      console.log(`  exists: ${filename}, setting cover`);
      release.cover = localPath;
      changed = true;
    }

    const wantsCover = refreshCovers || !release.cover;
    if (!wantsCover && !needsServices) continue;

    console.log(`  fetching: ${release.artist} — ${release.title}`);
    try {
      // The Odesli page is only scraped when something actually needs it.
      let odesli;
      const getOdesli = async () => (odesli ??= await fetchOdesli(release.link));

      if (needsServices) {
        const { services } = await getOdesli();
        // On --force, never drop a platform we already have. Merge the fresh
        // response over the existing services so re-fetches only ever add or
        // refresh keys, never lose one to a partial/transient response.
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

        // Apple Music fallback: Odesli misses it for many small releases, but
        // the iTunes Search API usually has it. Only fill if still absent.
        if (!release.services?.appleMusic) {
          const apple = await fetchAppleMusic(release.artist, release.title, release.type);
          if (apple) {
            release.services = { ...(release.services || {}), appleMusic: apple };
            changed = true;
            console.log(`    apple (itunes): ${apple}`);
          }
        }
      }

      if (wantsCover) {
        const apple = await appleArtwork(release.services?.appleMusic, release.title);
        const imageUrl = apple || (await getOdesli()).thumbnailUrl;
        if (!imageUrl) {
          console.log(`    no thumbnail found`);
        } else if (await downloadImage(imageUrl, destPath, MAX_EDGE, { onlyIfLarger: refreshCovers })) {
          if (release.cover !== localPath) {
            release.cover = localPath;
            changed = true;
          }
          console.log(`    saved: ${filename} (from ${apple ? 'apple' : 'odesli'})`);
        } else {
          console.log(`    kept: ${filename} (new ${apple ? 'apple' : 'odesli'} image is not bigger)`);
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

  await fetchFilmPosters();
}

// Run only as a script; add-playlist.js imports the helpers above.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
