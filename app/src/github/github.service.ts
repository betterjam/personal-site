import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isValidRepoRef, repoUrl } from '../common/repo-ref';
import {
  REPO_FETCHER,
  RepoFetcher,
  RepoResponse,
} from './repo-fetcher';

/**
 * What the widget renders. THREE states, all of them 200s:
 *
 * - `public`   — the repo answered with metadata.
 * - `private`  — upstream said 404 or 403. Private, renamed, or deleted;
 *   unauthenticated GitHub deliberately does not distinguish, so neither do
 *   we. This is a first-class state, not an error: Diego's own
 *   `betterjam/eleva-aws-infra-control` is private, and the card says so
 *   instead of linking visitors into a 404.
 * - `unavailable` — we could not ask (network, timeout, rate limit). The
 *   repo may well be fine; the site just does not know right now.
 *
 * `fullName` and `url` are present in every state, so the widget has a
 * label and (where linking makes sense) a destination no matter what.
 */
export type UnavailableReason = 'rate-limited' | 'timeout' | 'error';

export interface PublicRepoCard {
  state: 'public';
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  /** ISO timestamp of the last push; '' when upstream omitted it. */
  pushedAt: string;
  homepage: string | null;
}

export interface PrivateRepoCard {
  state: 'private';
  fullName: string;
  url: string;
}

export interface UnavailableRepoCard {
  state: 'unavailable';
  fullName: string;
  url: string;
  reason: UnavailableReason;
}

export type RepoCard = PublicRepoCard | PrivateRepoCard | UnavailableRepoCard;

/**
 * Cache TTLs. The unauthenticated GitHub API allows 60 requests per hour
 * PER IP — one shared budget for every visitor of the site — so the cache
 * is the feature, not an optimization.
 *
 * A public repo changes slowly (1h). A private/renamed/gone repo changes
 * even more slowly and its answer costs the same quota, so it is held
 * longest (6h). An unavailable answer is held briefly (5min): it means the
 * NEXT visitor after the rate limit resets, or after the network blips,
 * gets a real answer without waiting an hour — but a hard-down upstream
 * still cannot be hammered.
 */
export const PUBLIC_TTL_MS = 60 * 60 * 1000;
export const PRIVATE_TTL_MS = 6 * 60 * 60 * 1000;
export const UNAVAILABLE_TTL_MS = 5 * 60 * 1000;

/** Upstream gets 3 seconds; a page render never waits longer than that. */
export const REQUEST_TIMEOUT_MS = 3000;

/** GitHub requires a User-Agent and rejects requests without one. */
const USER_AGENT = 'diego-site (+https://github.com)';

const API_ROOT = 'https://api.github.com/repos';

/** Test seams; unset in production, where Nest provides no such token. */
export interface GithubOptions {
  now?: () => number;
  timeoutMs?: number;
}

export const GITHUB_OPTIONS = 'GITHUB_OPTIONS';

interface CacheEntry {
  card: RepoCard;
  expiresAt: number;
}

function ttlFor(card: RepoCard): number {
  switch (card.state) {
    case 'public':
      return PUBLIC_TTL_MS;
    case 'private':
      return PRIVATE_TTL_MS;
    default:
      return UNAVAILABLE_TTL_MS;
  }
}

/** Upstream JSON is untrusted input: read defensively or not at all. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

/**
 * A repo's `homepage` is free-form text an owner typed. It reaches a
 * browser, so anything that is not http(s) — `javascript:` above all — is
 * dropped rather than forwarded.
 */
function homepage(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  return /^https?:\/\/[^\s<>"']+$/.test(raw) ? raw : null;
}

function topics(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((topic): topic is string => typeof topic === 'string')
    : [];
}

/**
 * Server-side proxy for the repo widget. Three jobs, in this order:
 * frugality with a 60/hr shared quota, never throwing (the widget is
 * decoration — it must never take a page down), and never leaking the
 * token.
 *
 * Everything is in memory: a TTL cache keyed on the lowercased
 * `owner/name` (GitHub is case-insensitive, so `BetterJam/X` and
 * `betterjam/x` must not cost two requests) plus an in-flight map so N
 * concurrent placements of the same repo on one page make ONE upstream
 * call. A restart empties both, which is correct — nothing here is state
 * worth persisting.
 */
@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RepoCard>>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    @Inject(REPO_FETCHER) private readonly fetcher: RepoFetcher,
    @Optional() @Inject(GITHUB_OPTIONS) options?: GithubOptions,
  ) {
    this.now = options?.now ?? (() => Date.now());
    this.timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Always resolves, never rejects. Serves a live cache entry when there is
   * one, joins an in-flight request when there is one, and otherwise makes
   * exactly one upstream call.
   */
  getRepo(owner: string, name: string): Promise<RepoCard> {
    const fullName = `${owner}/${name}`;
    const key = fullName.toLowerCase();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return Promise.resolve(cached.card);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.load(owner, name)
      .then((card) => {
        this.cache.set(key, {
          card,
          expiresAt: this.now() + ttlFor(card),
        });
        return card;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  /** Drops every cached answer; the next read goes upstream again. */
  clearCache(): void {
    this.cache.clear();
  }

  /** One upstream call, every failure folded into a card. */
  private async load(owner: string, name: string): Promise<RepoCard> {
    const fullName = `${owner}/${name}`;
    const url = repoUrl(fullName);

    // The controller already rejected malformed refs with a 400. This is
    // the second lock on the same door: no unvalidated segment is ever
    // interpolated into the upstream URL, whatever calls this.
    if (!isValidRepoRef(fullName)) {
      return { state: 'unavailable', fullName, url, reason: 'error' };
    }

    const controller = new AbortController();
    // Not unref'd: the timeout is the only thing that can end a hung
    // request, so it has to be able to keep the loop alive until it fires.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${API_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { signal: controller.signal, headers: this.headers() },
      );
      return await this.readResponse(response, fullName, url);
    } catch (err) {
      const reason = failureReason(err, controller.signal);
      // Reason only: never the request headers, never the token.
      this.logger.warn(`GitHub request for ${fullName} failed (${reason})`);
      return { state: 'unavailable', fullName, url, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Status -> state. 404/403 both mean "we cannot see it" and map to
   * `private` WITHOUT guessing which flavour; a 403 (or 429) that carries
   * rate-limit headers is the one exception, because that one is about us,
   * not about the repo.
   */
  private async readResponse(
    response: RepoResponse,
    fullName: string,
    url: string,
  ): Promise<RepoCard> {
    const { status } = response;
    if (status === 200) {
      return publicCard(await response.json(), fullName, url);
    }
    if (status === 429 || (status === 403 && isRateLimited(response))) {
      this.logger.warn(`GitHub rate limit hit for ${fullName}`);
      return { state: 'unavailable', fullName, url, reason: 'rate-limited' };
    }
    if (status === 403 || status === 404) {
      return { state: 'private', fullName, url };
    }
    this.logger.warn(`GitHub responded ${status} for ${fullName}`);
    return { state: 'unavailable', fullName, url, reason: 'error' };
  }

  /**
   * Sends GITHUB_TOKEN as a Bearer credential when it is set, and nothing
   * at all when it is not. Read per request so a deploy that adds the
   * variable does not need a code path, and never logged or echoed in a
   * response — the token is the one thing in this module that must not
   * leave the process.
   */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }
}

/**
 * A 403 is rate limiting only when it says so: `x-ratelimit-remaining: 0`
 * or a `retry-after`. A plain 403 (token without access to a private repo)
 * is the `private` state, not an outage.
 */
function isRateLimited(response: RepoResponse): boolean {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null && remaining.trim() !== '' && Number(remaining) <= 0) {
    return true;
  }
  return response.headers.get('retry-after') !== null;
}

function failureReason(err: unknown, signal: AbortSignal): UnavailableReason {
  if (signal.aborted) {
    return 'timeout';
  }
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'error';
}

/**
 * Maps an upstream 200 body onto the public card. `full_name` is preferred
 * over the requested reference so a RENAMED repo renders under its current
 * name, but only after passing the same reference gate — the link the
 * widget renders is built here, never copied from `html_url`.
 */
function publicCard(
  body: unknown,
  requestedName: string,
  requestedUrl: string,
): PublicRepoCard {
  const data = (body ?? {}) as Record<string, unknown>;
  const canonical = text(data.full_name);
  const fullName =
    canonical !== null && isValidRepoRef(canonical) ? canonical : requestedName;
  return {
    state: 'public',
    fullName,
    url: fullName === requestedName ? requestedUrl : repoUrl(fullName),
    description: text(data.description),
    language: text(data.language),
    stars: count(data.stargazers_count),
    forks: count(data.forks_count),
    topics: topics(data.topics),
    pushedAt: text(data.pushed_at) ?? text(data.updated_at) ?? '',
    homepage: homepage(data.homepage),
  };
}
