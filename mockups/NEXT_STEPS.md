# AD93-style redesign: how to move forward

Mockup: [`ad93.html`](ad93.html) (open locally; reads `data.js`, covers from `src/assets/covers/`).
Published copy: https://claude.ai/artifact/VGMBHJVn2ZrP7yH4yNbCpA (private).
Reference: https://ad93.ltd/ (stylesheet: https://ad93.ltd/assets/scss/stylesheet.css).

The mockup is throwaway. Port the look into the Astro site; don't ship `ad93.html` or `data.js`.

## Decide first

- **Light or dark default?** ad93 is white-only. Mockup follows the system theme. `DARK_MODE` / `FORCE_DARK` in `src/config.ts` still work if tokens are renamed consistently.
- **Wordmark:** italic EB Garamond text, or a drawn SVG logo like ad93's?
- **Screensaver** (ad93's 30 s idle video): skipped in mockup. Add only if wanted.
- Replace the current design outright (simplest), or keep both behind a config flag?

## Port, file by file

1. **`src/styles/global.css`**: swap tokens to the mockup's `--paper / --ink / --text / --line / --sans / --serif`, 11px/12px body (9px/10px under 750px). Drop the grid, card overlay and Odesli modal styles once replaced.
2. **Fonts**: `npm i @fontsource/eb-garamond`, import it in `Layout.astro` next to Inter (self-hosted, no Google Fonts link).
3. **`src/layouts/Layout.astro`**: replace `<nav>` + `<footer>` with the fixed bottom UI: menu (Music / Film / Archive), wordmark + bio + ©, contact column (email, Spotify, Discogs as text links). Keep all `<head>` meta/OG tags and the visually-hidden `<h1>`.
4. **`src/components/ReleaseCard.astro`** → strip `<section>`: keep `<Picture>` but set `sizes="(max-width: 750px) 72vw, 30vw"`. Inline info panel (artist, title, credits, label, service links) replaces the `<dialog>` picker. Reuse from current script: `SERVICES` labels, `esc()`, the Mac `music://` Apple Music rewrite.
5. **`src/pages/index.astro`**: `.grid` → `.strip` (horizontal scroll-snap). Render the Archive list server-side from the same sorted array (artist / title / label rows) instead of the mockup's client-side `render()`.
6. **`src/pages/film.astro` + `FilmCard.astro`**: same treatment; director in the artist slot, role as credits, film company as label, Vimeo link as "Watch". Music/Film are real page links, not the mockup's JS swap.
7. **`src/config.ts`**: `SHOW_CREDITS` / `SHOW_LABEL` keep gating those fields. `SHOW_PHOTO` hero has no place in this layout. Remove it or put the photo in the strip.

Unchanged: `music.json`, `film.json`, `admin.js`, `fetch-covers.js` (data shape stays the same).

## Watch out for

- Page is `overflow: hidden`, all content is in the horizontal strip and archive list. Check keyboard tabbing reaches every cover and link, and add `prefers-reduced-motion` to kill the smooth scroll / slide transitions.
- Phones: strip ~46vh tall, footer stacked below. Test on a real phone (safe-area insets, iOS URL bar resizing `vh`; consider `svh`).
- ad93 uses `user-select: none` and hides scrollbars. Mockup keeps text selectable; keep it that way.

## Verify

`npm run check && npm run build && npm run preview`, then click through music, film, archive on desktop and phone width before pushing (CI deploys on push).
