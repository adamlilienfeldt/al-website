import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { slugify } from './lib/slug.js';
import { sleep } from './fetch-covers.js';
import { PLAYLIST_COVERS_DIR, SLUG_RE, parseTrackIds, resolveTrack, listPlaylists, writePlaylist, deletePlaylist } from './add-playlist.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_JSON = path.join(__dir, 'src/data/music.json');
const FILM_JSON  = path.join(__dir, 'src/data/film.json');
const PUBLIC     = path.join(__dir, 'public');
// Covers live in src/assets so astro:assets optimizes them at build time. The
// `cover` field keeps its logical "/images/<file>" form; covers.ts matches on
// the bare filename. Mirrors fetch-covers.js.
const COVERS_DIR = path.join(__dir, 'src/assets/covers');
// Stored originals; astro:assets derives delivered sizes. Mirrors fetch-covers.js.
const MAX_EDGE   = 1400;
// Film posters render up to a third of the page width, so keep more pixels.
// Mirrors FILM_MAX_EDGE in fetch-covers.js.
const FILM_MAX_EDGE = 1280;
const PORT       = process.env.PORT || 3001;

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(JSON.parse(body)));
  });
}

// Resize an uploaded cover and write it to src/assets/covers/ under the same
// <artist-title>.jpg slug fetch-covers.js uses, so the two paths agree. Returns
// the logical "/images/<file>" value for the `cover` field, or '' if no upload.
async function saveImage(cover, artist, title, maxEdge = MAX_EDGE) {
  if (!cover?.data) return '';
  const base64 = cover.data.replace(/^data:image\/\w+;base64,/, '');
  const input = Buffer.from(base64, 'base64');
  const filename = `${slugify(`${artist}-${title}`)}.jpg`;
  const output = await sharp(input)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(path.join(COVERS_DIR, filename), output);
  return `/images/${filename}`;
}

// Publishing commits only site content (data + covers), never code or stray
// files, then pushes main; GitHub Actions deploys from there.
const CONTENT = ['src/data', 'src/assets'];
const execFileP = promisify(execFile);
const git = async (...args) => (await execFileP('git', args, { cwd: __dir })).stdout.trimEnd(); // keep porcelain's leading space

async function publishStatus() {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const files = (await git('status', '--porcelain', '--untracked-files=all', '--', ...CONTENT))
    .split('\n').filter(Boolean).map(l => l.slice(3));
  // Commits saved locally but not yet pushed, e.g. after a failed publish.
  const ahead = Number(await git('rev-list', '--count', '@{u}..HEAD').catch(() => '0'));
  return { branch, files, ahead };
}

// "content: update music, playlists" from the changed paths.
function commitMessage(files) {
  const areas = new Set(files.map(f =>
    f.includes('music.json') ? 'music' : f.includes('film.json') ? 'film' : f.includes('playlists') ? 'playlists' : 'covers'));
  return `content: update ${[...areas].join(', ')}`;
}

function esc(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

function getHTML(releases, films, playlists) {
  const musicItems = releases.map(r => {
    const id = encodeURIComponent(`${r.artist}||${r.title}`);
    const cover = r.cover || '';
    return `<li class="item${r.hidden ? ' is-hidden' : ''}" data-hidden="${r.hidden ? '1' : ''}" data-id="${id}" data-cover="${esc(cover)}" data-artist="${esc(r.artist)}" data-title="${esc(r.title)}" data-type="${esc(r.type)}" data-year="${esc(r.year)}" data-link="${esc(r.link)}" data-credits="${esc(r.credits)}" data-label="${esc(r.label)}">
      <div class="item-row">
        <span class="handle">⠿</span>
        ${cover ? `<img src="${cover}" alt="">` : '<div class="thumb"></div>'}
        <span class="info"><strong>${r.artist}</strong> — ${r.title}</span>
        <div class="item-btns">
          <button class="edit-btn" onclick="toggleEdit(this,'music')" title="edit">✎</button>
          <button class="del-btn" onclick="deleteEntry(this,'music')" title="delete">×</button>
        </div>
      </div>
    </li>`;
  }).join('');

  const filmItems = films.map(f => {
    const id = encodeURIComponent(f.title);
    const cover = f.cover || '';
    const isVid = !!f.vimeo_id;
    return `<li class="item${f.hidden ? ' is-hidden' : ''}" data-hidden="${f.hidden ? '1' : ''}" data-id="${id}" data-cover="${esc(cover)}" data-title="${esc(f.title)}" data-role="${esc(f.role)}" data-director="${esc(f.director)}" data-company="${esc(f.film_company)}" data-vimeo="${esc(f.vimeo_id)}" data-year="${esc(f.year)}" data-link="${esc(f.link)}">
      <div class="item-row">
        <span class="handle">⠿</span>
        ${cover ? `<img src="${cover}" alt="">` : `<div class="thumb${isVid ? ' vid' : ''}">${isVid ? '▶' : ''}</div>`}
        <span class="info"><strong>${f.title}</strong>${f.role ? ` — ${f.role}` : ''}</span>
        <div class="item-btns">
          <button class="edit-btn" onclick="toggleEdit(this,'film')" title="edit">✎</button>
          <button class="del-btn" onclick="deleteEntry(this,'film')" title="delete">×</button>
        </div>
      </div>
    </li>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>admin — adam lilienfeldt</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Helvetica Neue", Helvetica, sans-serif; font-weight: 100; color: #111; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

    /* Tabs */
    .tabs { display: flex; border-bottom: 1px solid #eee; padding: 0 28px; flex-shrink: 0; }
    .tab { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 14px 20px 12px; font-family: inherit; font-weight: 100; font-size: 13px; color: #aaa; cursor: pointer; letter-spacing: 0.04em; }
    .tab.active { color: #111; border-bottom-color: #111; }
    .tab:hover { color: #111; }
    .publish { margin-left: auto; display: flex; align-items: center; gap: 14px; }
    .publish .save-btn { padding: 7px 16px; font-size: 12px; }

    /* Pages */
    .page { display: none; flex: 1; overflow: hidden; }
    .page.active { display: flex; }

    /* Panels */
    .panel-left { width: 380px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid #eee; overflow: hidden; }
    .panel-scroll { flex: 1; overflow-y: auto; padding: 24px 28px 12px; }
    .panel-footer { padding: 14px 28px 20px; flex-shrink: 0; border-top: 1px solid #f5f5f5; }
    .panel-right { flex: 1; padding: 24px 28px; overflow-y: auto; }

    /* List */
    ul { list-style: none; }
    .item { display: flex; flex-direction: column; border-bottom: 1px solid #f0f0f0; }
    .item.sortable-chosen { background: #f7f7f7; }
    .item.sortable-ghost { opacity: 0.3; }
    .item-row { display: flex; align-items: center; gap: 12px; padding: 7px 4px; user-select: none; }
    .handle { color: #ccc; font-size: 16px; cursor: grab; flex-shrink: 0; }
    .item img, .thumb { width: 38px; height: 38px; object-fit: cover; background: #e0e0e0; flex-shrink: 0; }
    .thumb { display: flex; align-items: center; justify-content: center; font-size: 13px; color: #bbb; }
    .thumb.vid { background: #1a1a1a; color: #555; }
    .info { font-size: 13px; line-height: 1.4; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
    .info strong { font-weight: 400; }
    .item-btns { display: flex; gap: 0; flex-shrink: 0; }
    .item.is-hidden .item-row > img, .item.is-hidden .thumb, .item.is-hidden .info, .preview-card.is-hidden { opacity: 0.3; }
    .edit-btn, .del-btn { background: none; border: none; cursor: pointer; padding: 3px 6px; font-size: 14px; color: #ddd; line-height: 1; }
    .edit-btn:hover { color: #111; }
    .del-btn:hover { color: #c00; }

    /* Edit panel */
    .edit-panel { padding: 6px 4px 14px 54px; background: #fafafa; }
    .edit-panel input, .edit-panel select { width: 100%; border: none; border-bottom: 1px solid #eee; padding: 6px 0; font-family: inherit; font-weight: 100; font-size: 13px; color: #111; background: none; outline: none; margin-bottom: 4px; }
    .edit-panel input::placeholder { color: #ccc; }
    .edit-panel input:focus, .edit-panel select:focus { border-bottom-color: #111; }
    .ep-cover-row { display: flex; align-items: center; gap: 8px; padding: 4px 0 6px; }
    .ep-thumb { width: 34px; height: 34px; object-fit: cover; }
    .ep-cover-row small { font-size: 11px; color: #aaa; }
    .ep-hidden-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; padding: 6px 0; cursor: pointer; }
    .edit-panel .ep-hidden-row input { width: auto; margin: 0; }
    .ep-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }

    /* Add section */
    .add-toggle { font-size: 13px; color: #bbb; cursor: pointer; padding: 12px 4px 2px; letter-spacing: 0.03em; }
    .add-toggle:hover { color: #111; }
    .add-form { display: none; padding: 10px 0 0; }
    .add-form.open { display: block; }
    .add-form input, .add-form select { width: 100%; border: none; border-bottom: 1px solid #eee; padding: 7px 0; font-family: inherit; font-weight: 100; font-size: 13px; color: #111; background: none; outline: none; margin-bottom: 4px; }
    .add-form textarea { width: 100%; height: 90px; border: 1px solid #eee; padding: 7px; font-family: inherit; font-weight: 100; font-size: 12px; color: #111; outline: none; resize: vertical; margin-bottom: 6px; }
    .add-form textarea:focus { border-color: #111; }
    .add-form input::placeholder, .add-form textarea::placeholder { color: #ccc; }
    .add-form input:focus, .add-form select:focus { border-bottom-color: #111; }
    .file-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
    .file-label { font-size: 12px; color: #aaa; cursor: pointer; border: 1px solid #ddd; padding: 5px 10px; white-space: nowrap; flex-shrink: 0; }
    .file-label:hover { border-color: #111; color: #111; }
    .file-label input[type=file] { display: none; }
    .cover-preview { width: 38px; height: 38px; object-fit: cover; display: none; }
    .cover-preview.shown { display: block; }
    .add-btn { padding: 8px 18px; background: #111; color: #fff; border: none; font-size: 12px; font-family: inherit; font-weight: 100; cursor: pointer; letter-spacing: 0.04em; }
    .add-btn:hover { background: #333; }
    .add-status { font-size: 12px; color: #888; min-height: 16px; }

    /* Playlists */
    .pl-fields { margin-bottom: 14px; }
    .pl-dur { font-size: 12px; color: #aaa; flex-shrink: 0; }
    .pl-info { font-size: 13px; line-height: 1.6; color: #888; }
    .pl-info a { color: #111; }

    /* Footer */
    .actions { display: flex; align-items: center; gap: 14px; }
    .save-btn { padding: 9px 20px; background: #111; color: #fff; border: none; font-size: 13px; font-family: inherit; font-weight: 100; cursor: pointer; letter-spacing: 0.04em; }
    .save-btn:hover { background: #333; }
    .status { font-size: 12px; color: #888; }

    /* Preview */
    .preview-label { font-size: 11px; font-weight: 100; color: #bbb; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 14px; }
    .preview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .preview-card { aspect-ratio: 1; background: #e0e0e0; overflow: hidden; position: relative; cursor: grab; container-type: inline-size; }
    .preview-card:active { cursor: grabbing; }
    .preview-card.sortable-ghost { opacity: 0.3; }
    .preview-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .preview-card.vid-card { background: #1a1a1a; display: flex; align-items: center; justify-content: center; color: #444; font-size: 20px; }
    /* Mirrors the site's hover overlay (.card-overlay in global.css), with
       sizes scaled to the tile so it reads the same at preview size. */
    .preview-card .label { position: absolute; inset: 0; background: rgba(0,0,0,0.72); color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 4px; padding: 8cqw; opacity: 0; transition: opacity 0.15s; }
    .preview-card .label-heading { font-size: clamp(11px, 7cqw, 22px); font-weight: 100; -webkit-text-stroke: 0.2px currentColor; line-height: 1.3; }
    .preview-card .label-info { font-size: clamp(10px, 5cqw, 15px); font-weight: 300; opacity: 0.7; line-height: 1.4; }
    .preview-card:hover .label { opacity: 1; }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('music')">music</button>
    <button class="tab" onclick="switchTab('film')">film</button>
    <button class="tab" onclick="switchTab('playlists')">playlists</button>
    <div class="publish">
      <span id="pub-status" class="status"></span>
      <button class="save-btn" onclick="publish()">publish</button>
    </div>
  </div>

  <!-- Music page -->
  <div id="music-page" class="page active">
    <div class="panel-left">
      <div class="panel-scroll">
        <ul id="music-list">${musicItems}</ul>
        <div class="add-toggle" onclick="toggleAdd('music')">+ add release</div>
        <div id="music-add-form" class="add-form">
          <input type="text" id="m-artist" placeholder="artist">
          <input type="text" id="m-title" placeholder="title">
          <select id="m-type">
            <option value="single">single</option>
            <option value="album">album</option>
            <option value="ep">ep</option>
          </select>
          <input type="text" id="m-year" placeholder="year">
          <input type="text" id="m-link" placeholder="link (song.link / album.link)">
          <div class="file-row">
            <label class="file-label"><input type="file" id="m-cover" accept="image/*" onchange="previewFile(this,'m-cover-img')"> choose cover</label>
            <img id="m-cover-img" class="cover-preview" src="" alt="">
          </div>
          <input type="text" id="m-credits" placeholder="credits">
          <input type="text" id="m-label" placeholder="label">
          <button class="add-btn" onclick="addMusic()">add release</button>
          <div id="m-add-status" class="add-status"></div>
        </div>
      </div>
      <div class="panel-footer">
        <div class="actions">
          <button class="save-btn" onclick="saveMusic()">save order</button>
          <span id="music-status" class="status"></span>
        </div>
      </div>
    </div>
    <div class="panel-right">
      <div class="preview-label">preview</div>
      <div id="music-preview" class="preview-grid"></div>
    </div>
  </div>

  <!-- Film page -->
  <div id="film-page" class="page">
    <div class="panel-left">
      <div class="panel-scroll">
        <ul id="film-list">${filmItems}</ul>
        <div class="add-toggle" onclick="toggleAdd('film')">+ add film</div>
        <div id="film-add-form" class="add-form">
          <input type="text" id="f-title" placeholder="title">
          <input type="text" id="f-role" placeholder="role (e.g. composer)">
          <input type="text" id="f-year" placeholder="year">
          <input type="text" id="f-link" placeholder="link">
          <input type="text" id="f-vimeo" placeholder="vimeo id (leave blank for poster)">
          <div class="file-row">
            <label class="file-label"><input type="file" id="f-cover" accept="image/*" onchange="previewFile(this,'f-cover-img')"> choose poster</label>
            <img id="f-cover-img" class="cover-preview" src="" alt="">
          </div>
          <button class="add-btn" onclick="addFilm()">add film</button>
          <div id="f-add-status" class="add-status"></div>
        </div>
      </div>
      <div class="panel-footer">
        <div class="actions">
          <button class="save-btn" onclick="saveFilm()">save order</button>
          <span id="film-status" class="status"></span>
        </div>
      </div>
    </div>
    <div class="panel-right">
      <div class="preview-label">preview</div>
      <div id="film-preview" class="preview-grid"></div>
    </div>
  </div>

  <!-- Playlists page -->
  <div id="playlists-page" class="page">
    <div class="panel-left">
      <div class="panel-scroll">
        <div class="add-form open pl-fields">
          <select id="pl-select" onchange="loadPlaylist(this.value)"></select>
          <input type="text" id="pl-slug" placeholder="url name, e.g. summer-mix">
          <input type="text" id="pl-title" placeholder="title">
          <input type="text" id="pl-desc" placeholder="description (optional)">
          <input type="text" id="pl-spotify" placeholder="spotify playlist link (optional, playlist must be public)">
        </div>
        <ul id="pl-list"></ul>
        <div class="add-toggle" onclick="toggleAdd('pl')">+ add songs</div>
        <div id="pl-add-form" class="add-form">
          <textarea id="pl-links" placeholder="paste spotify song links (select songs in spotify, cmd+c)"></textarea>
          <button class="add-btn" onclick="addSongs()">add songs</button>
          <div id="pl-add-status" class="add-status"></div>
        </div>
      </div>
      <div class="panel-footer">
        <div class="actions">
          <button class="save-btn" onclick="savePlaylist()">save playlist</button>
          <span id="pl-status" class="status"></span>
          <button id="pl-delete" class="del-btn" style="margin-left:auto;font-size:12px" onclick="deletePlaylist()">delete playlist</button>
        </div>
      </div>
    </div>
    <div class="panel-right">
      <div class="preview-label">page</div>
      <p id="pl-info" class="pl-info"></p>
    </div>
  </div>

  <script type="application/json" id="pl-data">${JSON.stringify(playlists).replace(/</g, '\\u003c')}</script>
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
  <script>
    // ─── Tabs ────────────────────────────────────────────────
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['music','film','playlists'][i] === name));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById(name + '-page').classList.add('active');
    }

    function toggleAdd(type) {
      document.getElementById(type + '-add-form').classList.toggle('open');
    }

    function previewFile(input, imgId) {
      if (!input.files[0]) return;
      const img = document.getElementById(imgId);
      img.src = URL.createObjectURL(input.files[0]);
      img.classList.add('shown');
    }

    function readFile(input) {
      return new Promise(resolve => {
        if (!input || !input.files[0]) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = e => resolve({ name: input.files[0].name, data: e.target.result });
        reader.readAsDataURL(input.files[0]);
      });
    }

    // ─── Edit / Delete ───────────────────────────────────────
    function toggleEdit(btn, type) {
      const li = btn.closest('.item');
      const existing = li.querySelector('.edit-panel');
      if (existing) { existing.remove(); return; }

      const d = li.dataset;
      const panel = document.createElement('div');
      panel.className = 'edit-panel';

      const mk = (tag, cls, val, ph) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (val !== undefined) el.value = val || '';
        if (ph) el.placeholder = ph;
        panel.appendChild(el);
        return el;
      };

      if (type === 'music') {
        mk('input', 'ep-artist', d.artist, 'artist').type = 'text';
        mk('input', 'ep-title', d.title, 'title').type = 'text';
        const sel = mk('select', 'ep-type');
        ['single','album','ep'].forEach(t => {
          const o = document.createElement('option');
          o.value = o.textContent = t;
          if (t === d.type) o.selected = true;
          sel.appendChild(o);
        });
        mk('input', 'ep-year', d.year, 'year').type = 'text';
        mk('input', 'ep-link', d.link, 'link').type = 'text';
        if (d.cover) {
          const row = document.createElement('div'); row.className = 'ep-cover-row';
          const img = document.createElement('img'); img.src = d.cover; img.className = 'ep-thumb';
          const lbl = document.createElement('small'); lbl.textContent = d.cover;
          row.append(img, lbl); panel.appendChild(row);
        }
        addFileRow(panel, 'replace cover');
        mk('input', 'ep-credits', d.credits, 'credits').type = 'text';
        mk('input', 'ep-labelval', d.label, 'label').type = 'text';
      } else {
        mk('input', 'ep-title', d.title, 'title').type = 'text';
        mk('input', 'ep-role', d.role, 'role').type = 'text';
        mk('input', 'ep-year', d.year, 'year').type = 'text';
        mk('input', 'ep-link', d.link, 'link').type = 'text';
        mk('input', 'ep-vimeo', d.vimeo, 'vimeo id').type = 'text';
        if (d.cover) {
          const row = document.createElement('div'); row.className = 'ep-cover-row';
          const img = document.createElement('img'); img.src = d.cover; img.className = 'ep-thumb';
          const lbl = document.createElement('small'); lbl.textContent = d.cover;
          row.append(img, lbl); panel.appendChild(row);
        }
        addFileRow(panel, 'replace poster');
      }

      const hr = document.createElement('label'); hr.className = 'ep-hidden-row';
      const hc = document.createElement('input'); hc.type = 'checkbox'; hc.className = 'ep-hidden'; hc.checked = !!d.hidden;
      hr.append(hc, 'hide from site'); panel.appendChild(hr);

      const acts = document.createElement('div'); acts.className = 'ep-actions';
      const sv = document.createElement('button'); sv.className = 'add-btn'; sv.textContent = 'save';
      const ca = document.createElement('button'); ca.className = 'add-btn'; ca.style.background = '#bbb'; ca.textContent = 'cancel';
      const st = document.createElement('span'); st.className = 'add-status ep-status';
      sv.onclick = () => saveEdit(sv, type);
      ca.onclick = () => panel.remove();
      acts.append(sv, ca, st);
      panel.appendChild(acts);
      li.appendChild(panel);
    }

    function addFileRow(panel, label) {
      const fr = document.createElement('div'); fr.className = 'file-row';
      const lbl = document.createElement('label'); lbl.className = 'file-label'; lbl.textContent = label;
      const fi = document.createElement('input'); fi.type = 'file'; fi.className = 'ep-cover-file'; fi.accept = 'image/*';
      const pi = document.createElement('img'); pi.className = 'cover-preview ep-cover-img';
      fi.onchange = () => { pi.src = URL.createObjectURL(fi.files[0]); pi.classList.add('shown'); };
      lbl.prepend(fi); fr.append(lbl, pi); panel.appendChild(fr);
    }

    async function saveEdit(btn, type) {
      const panel = btn.closest('.edit-panel');
      const li = panel.closest('.item');
      const originalId = decodeURIComponent(li.dataset.id);
      const status = panel.querySelector('.ep-status');
      status.textContent = 'saving...';
      const cover = await readFile(panel.querySelector('.ep-cover-file'));
      const g = cls => panel.querySelector(cls)?.value ?? '';
      let body;
      if (type === 'music') {
        body = { originalId, artist: g('.ep-artist'), title: g('.ep-title'), type: g('.ep-type'),
                 year: g('.ep-year'), link: g('.ep-link'), credits: g('.ep-credits'), label: g('.ep-labelval'), cover };
      } else {
        body = { originalId, title: g('.ep-title'), role: g('.ep-role'), year: g('.ep-year'),
                 link: g('.ep-link'), vimeo_id: g('.ep-vimeo'), cover };
      }
      body.hidden = panel.querySelector('.ep-hidden').checked;
      const res = await fetch('/edit-' + type, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (res.ok) { status.textContent = 'saved!'; setTimeout(() => location.reload(), 500); }
      else { status.textContent = 'error saving.'; }
    }

    async function deleteEntry(btn, type) {
      if (!confirm('Delete this entry?')) return;
      const li = btn.closest('.item');
      const id = decodeURIComponent(li.dataset.id);
      const res = await fetch('/delete-' + type, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      if (res.ok) location.reload();
      else alert('Error deleting.');
    }

    // ─── Music ───────────────────────────────────────────────
    let musicPreviewSortable;

    function updateMusicPreview() {
      document.getElementById('music-preview').innerHTML =
        [...document.querySelectorAll('#music-list .item')].map(el => {
          const cover = el.dataset.cover;
          return \`<div class="preview-card\${el.dataset.hidden ? ' is-hidden' : ''}" data-id="\${el.dataset.id}">
            \${cover ? \`<img src="\${cover}" alt="">\` : ''}
            <div class="label">
              <p class="label-heading">\${el.dataset.artist} - \${el.dataset.title}</p>
              \${el.dataset.credits ? \`<p class="label-info">\${el.dataset.credits}</p>\` : ''}
              \${el.dataset.label ? \`<p class="label-info">(\${el.dataset.label})</p>\` : ''}
            </div>
          </div>\`;
        }).join('');
      if (musicPreviewSortable) musicPreviewSortable.destroy();
      musicPreviewSortable = Sortable.create(document.getElementById('music-preview'), {
        animation: 120, onEnd: syncMusicListFromPreview
      });
    }

    function syncMusicListFromPreview() {
      const list = document.getElementById('music-list');
      [...document.querySelectorAll('#music-preview .preview-card')].forEach(card => {
        const li = list.querySelector(\`[data-id="\${card.dataset.id}"]\`);
        if (li) list.appendChild(li);
      });
    }

    Sortable.create(document.getElementById('music-list'), {
      animation: 120, handle: '.handle', onSort: updateMusicPreview
    });
    updateMusicPreview();

    async function saveMusic() {
      const ids = [...document.querySelectorAll('#music-list .item')].map(el => decodeURIComponent(el.dataset.id));
      const res = await fetch('/save-music', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ order: ids }) });
      document.getElementById('music-status').textContent = res.ok ? 'saved — commit and push to deploy.' : 'error.';
    }

    async function addMusic() {
      const artist = document.getElementById('m-artist').value.trim();
      const title  = document.getElementById('m-title').value.trim();
      if (!artist || !title) { document.getElementById('m-add-status').textContent = 'artist and title required.'; return; }
      const cover = await readFile(document.getElementById('m-cover'));
      const res = await fetch('/add-music', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ artist, title, type: document.getElementById('m-type').value,
          year: document.getElementById('m-year').value.trim(), link: document.getElementById('m-link').value.trim(),
          credits: document.getElementById('m-credits').value.trim(), label: document.getElementById('m-label').value.trim(), cover })
      });
      const data = await res.json();
      if (res.ok) { document.getElementById('m-add-status').textContent = 'added!'; setTimeout(() => location.reload(), 600); }
      else { document.getElementById('m-add-status').textContent = data.error || 'error.'; }
    }

    // ─── Film ────────────────────────────────────────────────
    let filmPreviewSortable;

    function updateFilmPreview() {
      document.getElementById('film-preview').innerHTML =
        [...document.querySelectorAll('#film-list .item')].map(el => {
          const cover = el.dataset.cover;
          const isVid = !!el.dataset.vimeo;
          return \`<div class="preview-card \${isVid && !cover ? 'vid-card' : ''}\${el.dataset.hidden ? ' is-hidden' : ''}" data-id="\${el.dataset.id}">
            \${isVid && !cover ? '▶' : ''}
            \${cover ? \`<img src="\${cover}" alt="">\` : ''}
            <div class="label">
              <p class="label-heading">\${el.dataset.title}</p>
              \${el.dataset.role ? \`<p class="label-info">\${el.dataset.role}</p>\` : ''}
              \${el.dataset.director ? \`<p class="label-info">dir. \${el.dataset.director}</p>\` : ''}
              \${el.dataset.company ? \`<p class="label-info">\${el.dataset.company}</p>\` : ''}
            </div>
          </div>\`;
        }).join('');
      if (filmPreviewSortable) filmPreviewSortable.destroy();
      filmPreviewSortable = Sortable.create(document.getElementById('film-preview'), {
        animation: 120, onEnd: syncFilmListFromPreview
      });
    }

    function syncFilmListFromPreview() {
      const list = document.getElementById('film-list');
      [...document.querySelectorAll('#film-preview .preview-card')].forEach(card => {
        const li = list.querySelector(\`[data-id="\${card.dataset.id}"]\`);
        if (li) list.appendChild(li);
      });
    }

    Sortable.create(document.getElementById('film-list'), {
      animation: 120, handle: '.handle', onSort: updateFilmPreview
    });
    updateFilmPreview();

    async function saveFilm() {
      const ids = [...document.querySelectorAll('#film-list .item')].map(el => decodeURIComponent(el.dataset.id));
      const res = await fetch('/save-film', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ order: ids }) });
      document.getElementById('film-status').textContent = res.ok ? 'saved — commit and push to deploy.' : 'error.';
    }

    async function addFilm() {
      const title = document.getElementById('f-title').value.trim();
      if (!title) { document.getElementById('f-add-status').textContent = 'title required.'; return; }
      const cover = await readFile(document.getElementById('f-cover'));
      const res = await fetch('/add-film', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ title, role: document.getElementById('f-role').value.trim(),
          year: document.getElementById('f-year').value.trim(), link: document.getElementById('f-link').value.trim(),
          vimeo_id: document.getElementById('f-vimeo').value.trim(), cover })
      });
      const data = await res.json();
      if (res.ok) { document.getElementById('f-add-status').textContent = 'added!'; setTimeout(() => location.reload(), 600); }
      else { document.getElementById('f-add-status').textContent = data.error || 'error.'; }
    }

    // ─── Playlists ───────────────────────────────────────────
    // Each song <li> carries its full track object (from add-playlist.js's
    // resolveTrack) in data-track; saving sends them in list order.
    const playlists = JSON.parse(document.getElementById('pl-data').textContent);
    let plSlug = ''; // '' = new playlist

    function plEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    }
    function fmtDur(s) { return s == null ? '' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    function plTracks() { return [...document.querySelectorAll('#pl-list .item')].map(li => JSON.parse(li.dataset.track)); }
    function plCurrentSlug() { return plSlug || document.getElementById('pl-slug').value.trim(); }

    function plTrackItem(t) {
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.track = JSON.stringify(t);
      li.innerHTML = '<div class="item-row"><span class="handle">⠿</span>' +
        (t.cover ? '<img src="/images/' + plEsc(t.cover) + '" alt="">' : '<div class="thumb"></div>') +
        '<span class="info"><strong>' + plEsc(t.artist) + '</strong> — ' + plEsc(t.title) + '</span>' +
        '<span class="pl-dur">' + fmtDur(t.duration) + '</span>' +
        '<div class="item-btns"><button class="del-btn" title="remove">×</button></div></div>';
      li.querySelector('.del-btn').onclick = () => { li.remove(); plChanged(); };
      return li;
    }

    function plUpdateInfo() {
      const slug = plCurrentSlug();
      const tracks = plTracks();
      const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
      let html = tracks.length + ' songs · ' + fmtDur(total);
      if (slug) {
        html += '<br><br>live after commit + push:<br>https://adamlilienfeldt.com/playlists/' + plEsc(slug) +
          '<br><br>local preview (npm run dev):<br><a href="http://localhost:4321/playlists/' + plEsc(slug) +
          '" target="_blank">localhost:4321/playlists/' + plEsc(slug) + '</a>';
      }
      document.getElementById('pl-info').innerHTML = html;
    }

    function plChanged() {
      document.getElementById('pl-status').textContent = 'unsaved changes';
      plUpdateInfo();
    }

    function loadPlaylist(slug) {
      plSlug = slug;
      const p = playlists.find(p => p.slug === slug) || { title: '', description: '', tracks: [] };
      const slugInput = document.getElementById('pl-slug');
      slugInput.style.display = slug ? 'none' : '';
      slugInput.value = '';
      document.getElementById('pl-title').value = p.title || '';
      document.getElementById('pl-desc').value = p.description || '';
      document.getElementById('pl-spotify').value = p.spotifyPlaylistUrl || '';
      document.getElementById('pl-delete').style.display = slug ? '' : 'none';
      document.getElementById('pl-list').replaceChildren(...(p.tracks || []).map(plTrackItem));
      document.getElementById('pl-status').textContent = '';
      plUpdateInfo();
    }

    async function addSongs() {
      const ta = document.getElementById('pl-links');
      const st = document.getElementById('pl-add-status');
      const n = ta.value.split(/\\s+/).filter(Boolean).length;
      if (!n) { st.textContent = 'paste spotify song links first.'; return; }
      st.textContent = 'looking up ' + n + ' song' + (n > 1 ? 's' : '') + '… (about a second each)';
      const res = await fetch('/resolve-tracks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text: ta.value }) });
      const data = await res.json();
      if (!res.ok) { st.textContent = data.error || 'error.'; return; }
      const list = document.getElementById('pl-list');
      const have = new Set(plTracks().map(t => t.services.spotify));
      let added = 0;
      for (const t of data.tracks) {
        if (have.has(t.services.spotify)) continue;
        list.appendChild(plTrackItem(t));
        have.add(t.services.spotify);
        added++;
      }
      ta.value = '';
      st.textContent = 'added ' + added + '.' + (data.errors.length ? ' problems: ' + data.errors.join('; ') : '');
      plChanged();
    }

    async function savePlaylist() {
      const slug = plCurrentSlug();
      const st = document.getElementById('pl-status');
      if (!plSlug && playlists.some(p => p.slug === slug)) { st.textContent = 'that url name is taken.'; return; }
      const body = { slug, title: document.getElementById('pl-title').value.trim(),
        description: document.getElementById('pl-desc').value.trim(),
        spotifyPlaylistUrl: document.getElementById('pl-spotify').value.trim(), tracks: plTracks() };
      const res = await fetch('/save-playlist', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { st.textContent = data.error || 'error.'; return; }
      if (!plSlug) { location.hash = 'pl=' + slug; location.reload(); return; }
      Object.assign(playlists.find(p => p.slug === slug), body);
      plSelect.selectedOptions[0].textContent = body.title || slug;
      st.textContent = 'saved — commit and push to publish.';
    }

    async function deletePlaylist() {
      const p = playlists.find(p => p.slug === plSlug);
      if (!p || !confirm('Delete the playlist "' + (p.title || p.slug) + '"? Its link stops working once you publish.')) return;
      const res = await fetch('/delete-playlist', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ slug: plSlug }) });
      if (res.ok) { location.hash = 'pl='; location.reload(); }
      else alert('Error deleting.');
    }

    // ─── Publish ─────────────────────────────────────────────
    // Ask first: list what will go out, then commit + push on OK.
    async function publish() {
      const st = document.getElementById('pub-status');
      st.textContent = '';
      const res = await fetch('/publish-status');
      const s = await res.json();
      if (!res.ok) { st.textContent = s.error || 'error.'; return; }
      if (s.branch !== 'main') { st.textContent = 'publishing only works on the main branch (now on ' + s.branch + ').'; return; }
      if (!s.files.length && !s.ahead) { st.textContent = 'nothing to publish.'; return; }
      const lines = s.files.map(f => '  ' + f);
      if (s.ahead) lines.push('  + ' + s.ahead + ' earlier saved change(s) not yet published');
      if (!confirm('Publish to adamlilienfeldt.com?\\n\\n' + lines.join('\\n') + '\\n\\nOnly saved changes are published.')) return;
      st.textContent = 'publishing…';
      const r = await fetch('/publish', { method: 'POST' });
      const d = await r.json();
      st.textContent = r.ok ? 'published — live in about 2 minutes.' : (d.error || 'error.');
    }

    const plSelect = document.getElementById('pl-select');
    plSelect.innerHTML = playlists.map(p => '<option value="' + plEsc(p.slug) + '">' + plEsc(p.title || p.slug) + '</option>').join('') +
      '<option value="">+ new playlist</option>';
    const plWanted = (location.hash.match(/pl=([a-z0-9-]+)/) || [])[1];
    if (plWanted && playlists.some(p => p.slug === plWanted)) { plSelect.value = plWanted; switchTab('playlists'); }
    loadPlaylist(plSelect.value);
    document.getElementById('pl-slug').oninput = plUpdateInfo;
    Sortable.create(document.getElementById('pl-list'), { animation: 120, handle: '.handle', onSort: plChanged });
  </script>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };

  if (req.method === 'GET' && req.url === '/') {
    const releases = JSON.parse(fs.readFileSync(MUSIC_JSON, 'utf8'));
    const films    = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
    const sortedR  = [...releases].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    const sortedF  = [...films].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(getHTML(sortedR, sortedF, listPlaylists()));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    const name = path.basename(req.url);
    const ext = path.extname(name);
    // Covers now live in src/assets/covers; fall back to public/images for any
    // legacy files still referenced.
    const candidates = [path.join(COVERS_DIR, name), path.join(PLAYLIST_COVERS_DIR, name), path.join(PUBLIC, 'images', name)];
    const filePath = candidates.find(p => fs.existsSync(p));
    if (filePath && MIME[ext]) { res.writeHead(200, {'Content-Type':MIME[ext]}); fs.createReadStream(filePath).pipe(res); return; }
  }

  if (req.method === 'POST' && req.url === '/save-music') {
    try {
      const { order } = await readBody(req);
      const releases = JSON.parse(fs.readFileSync(MUSIC_JSON, 'utf8'));
      order.forEach((id, i) => { const [a, t] = id.split('||'); const r = releases.find(r => r.artist === a && r.title === t); if (r) r.order = i + 1; });
      fs.writeFileSync(MUSIC_JSON, JSON.stringify(releases, null, 2) + '\n');
      json(200, { ok: true });
    } catch { json(500, { error: 'save failed' }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/save-film') {
    try {
      const { order } = await readBody(req);
      const films = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
      order.forEach((title, i) => { const f = films.find(f => f.title === title); if (f) f.order = i + 1; });
      fs.writeFileSync(FILM_JSON, JSON.stringify(films, null, 2) + '\n');
      json(200, { ok: true });
    } catch { json(500, { error: 'save failed' }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/add-music') {
    try {
      const body = await readBody(req);
      const releases = JSON.parse(fs.readFileSync(MUSIC_JSON, 'utf8'));
      const maxOrder = Math.max(0, ...releases.map(r => r.order ?? 0));
      releases.push({ order: maxOrder + 1, artist: body.artist, title: body.title, type: body.type || 'single',
        year: body.year || '', link: body.link || '', cover: await saveImage(body.cover, body.artist, body.title), credits: body.credits || '', label: body.label || '' });
      fs.writeFileSync(MUSIC_JSON, JSON.stringify(releases, null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/add-film') {
    try {
      const body = await readBody(req);
      const films = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
      const maxOrder = Math.max(0, ...films.map(f => f.order ?? 0));
      films.push({ order: maxOrder + 1, title: body.title, role: body.role || '', year: body.year || '',
        link: body.link || '', cover: await saveImage(body.cover, body.title, '', FILM_MAX_EDGE), vimeo_id: body.vimeo_id || '' });
      fs.writeFileSync(FILM_JSON, JSON.stringify(films, null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/edit-music') {
    try {
      const body = await readBody(req);
      const releases = JSON.parse(fs.readFileSync(MUSIC_JSON, 'utf8'));
      const [origArtist, origTitle] = body.originalId.split('||');
      const r = releases.find(r => r.artist === origArtist && r.title === origTitle);
      if (!r) { json(404, { error: 'not found' }); return; }
      const coverPath = body.cover ? await saveImage(body.cover, body.artist, body.title) : (r.cover || '');
      Object.assign(r, { artist: body.artist, title: body.title, type: body.type, year: body.year,
        link: body.link, cover: coverPath, credits: body.credits, label: body.label });
      if (body.hidden) r.hidden = true; else delete r.hidden;
      fs.writeFileSync(MUSIC_JSON, JSON.stringify(releases, null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/delete-music') {
    try {
      const { id } = await readBody(req);
      const [artist, title] = id.split('||');
      const releases = JSON.parse(fs.readFileSync(MUSIC_JSON, 'utf8'));
      fs.writeFileSync(MUSIC_JSON, JSON.stringify(releases.filter(r => !(r.artist === artist && r.title === title)), null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/edit-film') {
    try {
      const body = await readBody(req);
      const films = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
      const f = films.find(f => f.title === body.originalId);
      if (!f) { json(404, { error: 'not found' }); return; }
      const coverPath = body.cover ? await saveImage(body.cover, body.title, '', FILM_MAX_EDGE) : (f.cover || '');
      Object.assign(f, { title: body.title, role: body.role, year: body.year, link: body.link, vimeo_id: body.vimeo_id, cover: coverPath });
      if (body.hidden) f.hidden = true; else delete f.hidden;
      fs.writeFileSync(FILM_JSON, JSON.stringify(films, null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/delete-film') {
    try {
      const { id } = await readBody(req);
      const films = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
      fs.writeFileSync(FILM_JSON, JSON.stringify(films.filter(f => f.title !== id), null, 2) + '\n');
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && req.url === '/publish-status') {
    try { json(200, await publishStatus()); } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/publish') {
    try {
      const { branch, files, ahead } = await publishStatus();
      if (branch !== 'main') { json(400, { error: `publishing only works on the main branch (now on ${branch}).` }); return; }
      if (!files.length && !ahead) { json(400, { error: 'nothing to publish.' }); return; }
      if (files.length) {
        await git('add', '-A', '--', ...CONTENT);
        await git('commit', '-m', commitMessage(files), '--', ...CONTENT);
      }
      // Fetch separately so "can't reach github" isn't reported as a clash.
      try { await git('fetch'); }
      catch { json(502, { error: "couldn't reach github. check the internet connection and publish again — your changes are saved." }); return; }
      try {
        await git('rebase', '--autostash', '@{u}');
      } catch {
        // Abort also restores the autostashed files. If even that fails the repo
        // is mid-rebase, so say so rather than the usual message.
        const stuck = await git('rebase', '--abort').then(() => false, () => true);
        json(409, { error: stuck
          ? 'publishing stopped halfway (git is mid-rebase). ask for help before changing anything else.'
          : 'github has changes that clash with yours. your changes are saved on this computer but not published. ask for help before publishing again.' });
        return;
      }
      await git('push');
      json(200, { ok: true });
    } catch (e) { json(500, { error: `publish failed: ${e.stderr?.trim() || e.message}` }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/delete-playlist') {
    try {
      const { slug } = await readBody(req);
      deletePlaylist(slug);
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  // Look up pasted Spotify track links (song.link scrape, iTunes, cover
  // download). Slow on purpose: ~1s per track to be polite to song.link.
  if (req.method === 'POST' && req.url === '/resolve-tracks') {
    try {
      const { text } = await readBody(req);
      const { ids, bad } = parseTrackIds(text);
      const tracks = [];
      const errors = bad.map(b => `not a spotify track link: ${b}`);
      for (const id of ids) {
        try { tracks.push(await resolveTrack(id)); }
        catch (e) { errors.push(`${id}: ${e.message}`); }
        await sleep(800);
      }
      json(200, { tracks, errors });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/save-playlist') {
    try {
      const { slug, title, description, spotifyPlaylistUrl, tracks } = await readBody(req);
      if (!SLUG_RE.test(slug || '')) { json(400, { error: 'url name: lowercase letters, digits and dashes only.' }); return; }
      if (spotifyPlaylistUrl && !/^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+/.test(spotifyPlaylistUrl)) {
        json(400, { error: 'spotify playlist link should look like https://open.spotify.com/playlist/…' }); return;
      }
      writePlaylist(slug, { title: title || slug.replace(/-/g, ' '), description: description || '',
        spotifyPlaylistUrl: spotifyPlaylistUrl || '', tracks });
      json(200, { ok: true });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  res.writeHead(404); res.end();
});

// Localhost only: the admin can edit files and push to GitHub, so it must
// not be reachable from other machines on the network.
server.listen(PORT, '127.0.0.1', () => { console.log(`\nAdmin → http://localhost:${PORT}\n`); });
