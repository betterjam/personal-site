/**
 * The one seam between the proxy and the network.
 *
 * GithubService talks to this narrow contract instead of the global
 * `fetch`, which is what lets `npm test` cover every branch — 200, 404,
 * 403 + rate-limit headers, timeouts — with a stub and ZERO live requests.
 * The shape is deliberately the subset of a fetch Response the proxy
 * actually reads, so the real implementation is a one-line pass-through and
 * a stub is an object literal.
 */

export interface RepoResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** Parsed body; may reject, which the proxy treats as an upstream error. */
  json(): Promise<unknown>;
}

export interface RepoRequestInit {
  /** Aborted by the proxy's own timeout. */
  signal: AbortSignal;
  headers: Record<string, string>;
}

export type RepoFetcher = (
  url: string,
  init: RepoRequestInit,
) => Promise<RepoResponse>;

/** Injection token for the fetcher implementation. */
export const REPO_FETCHER = 'GITHUB_REPO_FETCHER';

/** The production fetcher: Node's global fetch, nothing added. */
export function createRepoFetcher(): RepoFetcher {
  return (url, init) => fetch(url, init);
}
