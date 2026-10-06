#!/usr/bin/env node

// The AL Site Admin icon: "al" in the site's thin Helvetica Neue (like the
// "adam lilienfeldt" nav heading) on a white macOS icon tile. Drawn from SVG
// with sharp, so no image files live in the repo.
//
//   node admin-icon.js <dir.iconset>   # writes the sizes iconutil needs
//
// admin.js also serves it as the admin page's favicon.

import { mkdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import sharp from 'sharp';

// Weight 100 is the site's look but vanishes at a few pixels, so small
// sizes get a heavier cut.
function iconSvg(px) {
  const weight = px <= 64 ? 300 : 100;
  // Apple's macOS icon grid: 824px tile with 100px margin on a 1024 canvas.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#ffffff"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#000" stroke-opacity="0.08"/>
  <text x="512" y="512" dy="0.35em" text-anchor="middle" font-family="Helvetica Neue" font-weight="${weight}"
    font-size="440" letter-spacing="17.6" fill="#111111">al</text>
</svg>`;
}

export function renderIcon(px) {
  return sharp(Buffer.from(iconSvg(px))).png().toBuffer();
}

async function main() {
  const dir = process.argv[2];
  if (!dir?.endsWith('.iconset')) {
    console.error('usage: node admin-icon.js <dir.iconset>');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(await renderIcon(size)).toFile(join(dir, `icon_${size}x${size}.png`));
    await sharp(await renderIcon(size * 2)).toFile(join(dir, `icon_${size}x${size}@2x.png`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
