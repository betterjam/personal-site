/**
 * Kebab-cases a title into a URL slug: lowercases, strips diacritics and
 * apostrophes, collapses every other non-alphanumeric run into a single
 * hyphen, and trims leading/trailing hyphens.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
