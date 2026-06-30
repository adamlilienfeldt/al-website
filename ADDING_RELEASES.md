# Adding a release to the discography

The music grid is driven by [`src/data/music.json`](src/data/music.json). Each
release is one object in that array. Covers and streaming-service links are
filled in automatically by [`fetch-covers.js`](fetch-covers.js) — you only
hand-write the basic fields.

## TL;DR

1. Add an entry to `src/data/music.json` (minimum: `artist`, `title`, `link`, `order`).
2. Run `npm run fetch-covers` — pulls the cover art **and** the streaming links.
3. `npm run build` to check it locally, then commit + push.

That's it. CI builds and deploys on push.

## 1. Add the entry

Append an object to the array in `src/data/music.json`:

```json
{
  "order": 7,
  "artist": "ELBA",
  "title": "nu skal hele verden dreje sig om mig",
  "type": "single",
  "year": "2026",
  "link": "https://open.spotify.com/track/1EToAwQ2ecOX3CSan1mumw",
  "credits": "producer, mixer, various instruments",
  "label": "Nordic Music Society"
}
```

### Fields

| Field      | Required | Notes |
|------------|----------|-------|
| `artist`   | yes      | Display name. |
| `title`    | yes      | Display name. |
| `link`     | yes      | Any streaming or Odesli link — a raw Spotify/Apple URL, or a `song.link`/`album.link` shortlink. This is what `fetch-covers.js` resolves. |
| `order`    | yes      | Sort position in the grid (ascending). Pick a free number; gaps are fine. |
| `type`     | no       | `single` / `EP` / `album`. Shown only if enabled in [`src/config`](src/config.ts). |
| `year`     | no       | Shown only if enabled in config. |
| `credits`  | no       | e.g. `"producer, mixer"`. |
| `label`    | no       | e.g. `"Nordic Music Society"`. |
| `cover`    | auto     | **Leave it out.** Filled by `fetch-covers.js`. |
| `services` | auto     | **Leave it out.** Filled by `fetch-covers.js`. |

The best `link` is a **raw Spotify track/album URL** — it resolves cleanly. Odesli
shortlinks work too. Strip any `?si=...` tracking suffix if you like (not required).

## 2. Fetch cover + links

```bash
npm run fetch-covers
```

This, for every entry missing a `cover` or `services`:

- downloads the album art, resizes it, and writes it to
  `src/assets/covers/<artist-title>.jpg`
- sets `"cover": "/images/<artist-title>.jpg"` (a logical key — the file actually
  lives in `src/assets/covers/`, see [`src/lib/covers.ts`](src/lib/covers.ts))
- scrapes the `song.link` page for the streaming links and writes `"services"`
  (Spotify / Apple Music / YouTube / YouTube Music / Tidal, whichever exist)

It **skips** entries that already have both, so re-running is safe and cheap.

To re-pull links for entries that already have some (e.g. to enrich them):

```bash
npm run fetch-covers -- --force
```

`--force` never overwrites richer data with a thinner response.

> **Why a page scrape, not the Odesli API?** The free API rate-limits hard and
> 400s on its own shortlinks. The public `song.link` page carries the full link
> set with none of that pain. See [`fetch-covers.js`](fetch-covers.js).

### If a cover doesn't come through

Drop a `<artist-title>.jpg` into `src/assets/covers/` by hand (slug =
lowercased `artist-title`, non-alphanumerics → `-`). Re-run `npm run fetch-covers`
and it'll pick up the existing file and set the `cover` field.

## 3. Build, commit, push

```bash
npm run build        # local check — also generates optimized AVIF/WebP/JPG
git add src/data/music.json src/assets/covers/
git commit -m "music: add <artist> — <title>"
git push
```

`npm run build` does **not** fetch anything (it's just `astro build`) — so always
run `npm run fetch-covers` first when adding a release. CI deploys on push.

## Notes

- **Apple Music / YouTube are often missing** for smaller releases — that's
  Odesli's data gap, not a bug. The picker just shows whatever exists.
- **`admin.js` (`npm run admin`) is currently out of sync** with this pipeline:
  it saves covers to `public/images/` (which the build no longer reads) and
  doesn't set `services` or run the fetch. Use it only for reordering /
  editing text fields — not for adding covers. Prefer the JSON + fetch flow
  above. (Fixing admin to write to `src/assets/covers/` and trigger the fetch
  is a possible future cleanup.)
