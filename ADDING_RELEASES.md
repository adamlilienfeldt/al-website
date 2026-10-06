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

> Prefer a UI? There's a local admin tool — `npm run admin` (port 3001) —
> for adding / editing / reordering without touching JSON by hand. See
> [Notes](#notes) for the caveat. The JSON flow above is still the source of truth.

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

- downloads the album art (up to 1400px) and writes it to
  `src/assets/covers/<artist-title>.jpg`. It prefers Apple's artwork, which
  comes at full size; Spotify's (via `song.link`) tops out at 640px. Apple's is
  only used when Apple lists the same release: if a single only exists there as
  a track on an EP or album, that cover would be the wrong one.
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

To re-download existing covers from the best source (e.g. after Apple adds a
release, or to upgrade small ones):

```bash
npm run fetch-covers -- --covers
```

A cover is only replaced when the new image is bigger, so hand-picked or
larger files are never downgraded. It keeps each cover's current filename.

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

## Adding a film with a Vimeo video

Film entries live in [`src/data/film.json`](src/data/film.json). A video entry
needs a `vimeo_id` **and** a `cover`: the player iframe is only loaded when a
visitor clicks play, so the `cover` image is what they see until then. Without
one the card renders black (still playable, just no thumbnail).

You don't have to make the poster yourself:

1. Add the entry with `title`, `vimeo_id` and `order` — leave `cover` out.
2. Run `npm run fetch-covers`. It pulls Vimeo's own thumbnail for any video
   entry missing a cover, writes it to `src/assets/covers/<slug>.jpg`, and
   fills in the `cover` field.

Same command as the music flow, and it's safe to re-run — entries that already
have a cover are skipped.

## Notes

- **Apple Music / YouTube are often missing** for smaller releases — that's
  Odesli's data gap, not a bug. The picker just shows whatever exists.
- **`admin.js` (`npm run admin`)** is a local web UI (port 3001) for
  adding / editing / reordering entries without touching JSON by hand. It now
  writes uploaded covers to `src/assets/covers/` (resized, same slug as
  `fetch-covers.js`), so its covers feed the build correctly. It does **not**
  set `services` — after adding a release in admin, still run
  `npm run fetch-covers` to pull the streaming links.

## Playlists (link-only pages)

Easiest: `npm run admin` → **playlists** tab. Pick a playlist or "+ new playlist", paste Spotify song links under "+ add songs", drag to reorder, × to remove, then **save playlist**. Or from the terminal:

```
npm run playlist:add -- <slug>                      # links from clipboard (Cmd+C in Spotify)
npm run playlist:add -- <slug> <spotify-track-url> ...
```

Creates `src/data/playlists/<slug>.json` and covers in `src/assets/playlists/`, served at `/playlists/<slug>`. Edit `title`, `description` and (once the playlist is public) `spotifyPlaylistUrl` in the json, then commit. Re-running with the same slug rebuilds the track list and keeps those fields. Playlist pages are `noindex`, not in the nav and not in the sitemap. Tracks missing on Apple Music or Tidal link to their song.link page.

## Site Admin app (no terminal)

Install once: `npm run admin:app` puts **Site Admin.app** in /Applications. Open it to start the admin console in your browser; quit it (Cmd+Q) to stop it. Rebuild with the same command if the repo or Node moves.

The **publish** button (top right) lists the saved changes and asks before publishing. It commits only `src/data/` and `src/assets/`, pushes `main`, and the site updates about 2 minutes later. It only works on the `main` branch. If GitHub is unreachable or has clashing changes, nothing is lost: the changes stay on this computer.

### On another Mac

Paste into Terminal once:

```
bash <(curl -fsSL https://raw.githubusercontent.com/adamlilienfeldt/al-website/main/install-admin.sh)
```

It installs what's missing (git, Node, GitHub login), downloads the site to `~/Code/DEV/al-website`, checks publishing works and installs **Site Admin.app**. Each Mac has its own copy. Site Admin fetches the latest from GitHub when it starts, so publish when you're done on one Mac and the other picks it up next time it opens Site Admin.
