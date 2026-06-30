import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { slugify } from './lib/slug.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_JSON = path.join(__dir, 'src/data/music.json');
const FILM_JSON  = path.join(__dir, 'src/data/film.json');
const PUBLIC     = path.join(__dir, 'public');
// Covers live in src/assets so astro:assets optimizes them at build time. The
// `cover` field keeps its logical "/images/<file>" form; covers.ts matches on
// the bare filename. Mirrors fetch-covers.js.
const COVERS_DIR = path.join(__dir, 'src/assets/covers');
const MAX_EDGE   = 660;
const PORT       = 3001;

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
async function saveImage(cover, artist, title) {
  if (!cover?.data) return '';
  const base64 = cover.data.replace(/^data:image\/\w+;base64,/, '');
  const input = Buffer.from(base64, 'base64');
  const filename = `${slugify(`${artist}-${title}`)}.jpg`;
  const output = await sharp(input)
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(path.join(COVERS_DIR, filename), output);
  return `/images/${filename}`;
}

function esc(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

function getHTML(releases, films) {
  const musicItems = releases.map(r => {
    const id = encodeURIComponent(`${r.artist}||${r.title}`);
    const cover = r.cover || '';
    return `<li class="item" data-id="${id}" data-cover="${esc(cover)}" data-artist="${esc(r.artist)}" data-title="${esc(r.title)}" data-type="${esc(r.type)}" data-year="${esc(r.year)}" data-link="${esc(r.link)}" data-credits="${esc(r.credits)}" data-label="${esc(r.label)}">
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
    return `<li class="item" data-id="${id}" data-cover="${esc(cover)}" data-title="${esc(f.title)}" data-role="${esc(f.role)}" data-vimeo="${esc(f.vimeo_id)}" data-year="${esc(f.year)}" data-link="${esc(f.link)}">
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
    .ep-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }

    /* Add section */
    .add-toggle { font-size: 13px; color: #bbb; cursor: pointer; padding: 12px 4px 2px; letter-spacing: 0.03em; }
    .add-toggle:hover { color: #111; }
    .add-form { display: none; padding: 10px 0 0; }
    .add-form.open { display: block; }
    .add-form input, .add-form select { width: 100%; border: none; border-bottom: 1px solid #eee; padding: 7px 0; font-family: inherit; font-weight: 100; font-size: 13px; color: #111; background: none; outline: none; margin-bottom: 4px; }
    .add-form input::placeholder { color: #ccc; }
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

    /* Footer */
    .actions { display: flex; align-items: center; gap: 14px; }
    .save-btn { padding: 9px 20px; background: #111; color: #fff; border: none; font-size: 13px; font-family: inherit; font-weight: 100; cursor: pointer; letter-spacing: 0.04em; }
    .save-btn:hover { background: #333; }
    .status { font-size: 12px; color: #888; }

    /* Preview */
    .preview-label { font-size: 11px; font-weight: 100; color: #bbb; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 14px; }
    .preview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .preview-card { aspect-ratio: 1; background: #e0e0e0; overflow: hidden; position: relative; cursor: grab; }
    .preview-card:active { cursor: grabbing; }
    .preview-card.sortable-ghost { opacity: 0.3; }
    .preview-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .preview-card.vid-card { background: #1a1a1a; display: flex; align-items: center; justify-content: center; color: #444; font-size: 20px; }
    .preview-card .label { position: absolute; inset: 0; background: rgba(0,0,0,0.6); color: #fff; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 10px; padding: 6px; opacity: 0; transition: opacity 0.15s; line-height: 1.4; }
    .preview-card:hover .label { opacity: 1; }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('music')">music</button>
    <button class="tab" onclick="switchTab('film')">film</button>
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

  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
  <script>
    // ─── Tabs ────────────────────────────────────────────────
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['music','film'][i] === name));
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
          return \`<div class="preview-card" data-id="\${el.dataset.id}">
            \${cover ? \`<img src="\${cover}" alt="">\` : ''}
            <div class="label">\${el.dataset.artist}<br><span style="opacity:0.7">\${el.dataset.title}</span></div>
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
          return \`<div class="preview-card \${isVid && !cover ? 'vid-card' : ''}" data-id="\${el.dataset.id}">
            \${isVid && !cover ? '▶' : ''}
            \${cover ? \`<img src="\${cover}" alt="">\` : ''}
            <div class="label">\${el.dataset.title}\${el.dataset.role ? \`<br><span style="opacity:0.7">\${el.dataset.role}</span>\` : ''}</div>
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
    res.end(getHTML(sortedR, sortedF));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    const name = path.basename(req.url);
    const ext = path.extname(name);
    // Covers now live in src/assets/covers; fall back to public/images for any
    // legacy files still referenced.
    const candidates = [path.join(COVERS_DIR, name), path.join(PUBLIC, 'images', name)];
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
        link: body.link || '', cover: await saveImage(body.cover, body.title, ''), vimeo_id: body.vimeo_id || '' });
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
      const coverPath = body.cover ? await saveImage(body.cover, body.title, '') : (f.cover || '');
      Object.assign(f, { title: body.title, role: body.role, year: body.year, link: body.link, vimeo_id: body.vimeo_id, cover: coverPath });
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

  res.writeHead(404); res.end();
});

server.listen(PORT, () => { console.log(`\nAdmin → http://localhost:${PORT}\n`); });
