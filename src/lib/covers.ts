import type { ImageMetadata } from 'astro';

// Eagerly import every cover so it can be optimized by astro:assets at build
// time. Keyed by bare filename, since music.json/film.json store covers as
// logical paths like "/images/foo.jpg" (the leading dir is historical — the
// files actually live here in src/assets/covers/).
const imports = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/covers/*.{jpg,jpeg,png}',
  { eager: true },
);

const byFilename = new Map<string, ImageMetadata>(
  Object.entries(imports).map(([path, mod]) => [path.split('/').pop()!, mod.default]),
);

/** Resolve a data-file `cover` value to its imported (optimizable) asset. */
export function resolveCover(cover?: string): ImageMetadata | undefined {
  if (!cover) return undefined;
  return byFilename.get(cover.split('/').pop()!);
}
