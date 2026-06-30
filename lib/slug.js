// Shared cover-filename slug. fetch-covers.js and admin.js both write covers to
// src/assets/covers/<slug>.jpg, so they must agree on the slug exactly.
export function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
