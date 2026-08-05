/**
 * ONE repository reference format, shared by the page `repo` field and the
 * GitHub proxy route: `owner/name` over the characters GitHub itself
 * allows (letters, digits, `_`, `.`, `-`), at most 39 for the owner and
 * 100 for the name.
 *
 * The proxy interpolates the two segments into an api.github.com URL, so
 * this is the only gate that stands between a request path and an outbound
 * call: no second slash (a third segment cannot smuggle a different upstream
 * path), no spaces, no `%`, no `:`, no `?`, no `#`.
 *
 * The pattern alone is not quite enough. `.` is in the character class and
 * is NOT escaped by encodeURIComponent, so `../..` would satisfy the regex
 * and still normalize away the `/repos/` prefix upstream. An all-dots
 * segment is therefore rejected on top of the pattern — GitHub has no such
 * owner or repository anyway.
 */
export const REPO_REF = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

/** `.`, `..`, `...`: pattern-legal, traversal-shaped, never a real repo. */
const ALL_DOTS = /^\.+$/;

/** True when `value` is a usable `owner/name` reference. */
export function isValidRepoRef(value: string): boolean {
  if (!REPO_REF.test(value)) {
    return false;
  }
  const [owner, name] = value.split('/');
  return !ALL_DOTS.test(owner) && !ALL_DOTS.test(name);
}

/**
 * The repo's page on github.com. Only ever called with a reference that
 * passed `isValidRepoRef`, which is what keeps the result a github.com URL
 * and nothing else — the widget links to it, so it is never built from an
 * upstream-supplied string.
 */
export function repoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}
