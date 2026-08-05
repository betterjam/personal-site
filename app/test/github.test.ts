import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  GithubService,
  PRIVATE_TTL_MS,
  PUBLIC_TTL_MS,
  RepoCard,
  UNAVAILABLE_TTL_MS,
} from '../src/github/github.service';
import {
  RepoFetcher,
  RepoRequestInit,
  RepoResponse,
} from '../src/github/repo-fetcher';
import { validateRepoParams } from '../src/github/validate';

/**
 * NOTHING in this file touches the network: every upstream branch is a
 * stubbed RepoFetcher. The real GitHub API allows 60 unauthenticated
 * requests per hour per IP, which is a budget a test suite must never
 * spend.
 */

interface Call {
  url: string;
  headers: Record<string, string>;
}

type Handler = (
  url: string,
  init: RepoRequestInit,
) => RepoResponse | Promise<RepoResponse>;

/** A fetcher that records what it was asked for. */
function recorder(handler: Handler): { fetcher: RepoFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: RepoFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return handler(url, init);
  };
  return { fetcher, calls };
}

function reply(init: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): RepoResponse {
  return {
    status: init.status,
    headers: {
      get: (name: string) => init.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => init.body ?? {},
  };
}

/** A full-ish api.github.com repo payload, trimmed to what we read. */
const REPO_BODY = {
  full_name: 'octocat/Hello-World',
  html_url: 'https://github.com/octocat/Hello-World',
  description: 'My first repository on GitHub!',
  language: 'TypeScript',
  stargazers_count: 2431,
  forks_count: 187,
  topics: ['nestjs', 'event-sourcing', 'aws'],
  pushed_at: '2026-07-30T09:12:04Z',
  homepage: 'https://example.com',
  private: false,
  // Fields we deliberately ignore.
  owner: { login: 'octocat' },
  watchers_count: 2431,
};

/** Runs fn with GITHUB_TOKEN set (undefined = unset), then restores. */
async function withToken(
  token: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = process.env.GITHUB_TOKEN;
  if (token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
}

/** Captures everything the process writes while fn runs (Nest logs included). */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((stream) => stream.write.bind(stream));
  streams.forEach((stream) => {
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(String(chunk));
      void rest;
      return true;
    }) as typeof stream.write;
  });
  try {
    await fn();
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index];
    });
  }
  return chunks.join('');
}

// --- upstream mapping -----------------------------------------------------

test('upstream 200 maps to the public card the widget renders', async () => {
  const { fetcher, calls } = recorder(() =>
    reply({ status: 200, body: REPO_BODY }),
  );
  const card = await new GithubService(fetcher).getRepo(
    'octocat',
    'Hello-World',
  );

  assert.deepEqual(card, {
    state: 'public',
    fullName: 'octocat/Hello-World',
    url: 'https://github.com/octocat/Hello-World',
    description: 'My first repository on GitHub!',
    language: 'TypeScript',
    stars: 2431,
    forks: 187,
    topics: ['nestjs', 'event-sourcing', 'aws'],
    pushedAt: '2026-07-30T09:12:04Z',
    homepage: 'https://example.com',
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://api.github.com/repos/octocat/Hello-World'],
  );
});

test('a sparse or hostile 200 body still produces a renderable card', async () => {
  const { fetcher } = recorder(() =>
    reply({
      status: 200,
      body: {
        // No full_name, no description, no counts, junk topics, and a
        // homepage that must never reach an href.
        language: '',
        stargazers_count: -4,
        forks_count: 'many',
        topics: ['ok', 7, null],
        homepage: 'javascript:alert(1)',
        updated_at: '2026-07-01T00:00:00Z',
      },
    }),
  );
  const card = await new GithubService(fetcher).getRepo('betterjam', 'site');

  assert.deepEqual(card, {
    state: 'public',
    fullName: 'betterjam/site',
    url: 'https://github.com/betterjam/site',
    description: null,
    language: null,
    stars: 0,
    forks: 0,
    topics: ['ok'],
    pushedAt: '2026-07-01T00:00:00Z',
    homepage: null,
  });
});

test('a renamed repo reports its current name, from a link we build ourselves', async () => {
  const { fetcher } = recorder(() =>
    reply({
      status: 200,
      body: {
        full_name: 'betterjam/infra-control',
        // An upstream-supplied URL is never echoed back to the browser.
        html_url: 'https://evil.example.com/pwned',
      },
    }),
  );
  const card = await new GithubService(fetcher).getRepo('betterjam', 'panel');
  assert.equal(card.fullName, 'betterjam/infra-control');
  assert.equal(card.url, 'https://github.com/betterjam/infra-control');
});

test('upstream 404 and plain 403 map to private: a state, not an error', async () => {
  for (const status of [404, 403]) {
    const { fetcher } = recorder(() => reply({ status }));
    const card = await new GithubService(fetcher).getRepo(
      'betterjam',
      'eleva-aws-infra-control',
    );
    assert.deepEqual(
      card,
      {
        state: 'private',
        fullName: 'betterjam/eleva-aws-infra-control',
        url: 'https://github.com/betterjam/eleva-aws-infra-control',
      },
      `upstream ${status} is private`,
    );
  }
});

test('403 with rate-limit headers is unavailable(rate-limited), not private', async () => {
  const rateLimited: Array<{ status: number; headers: Record<string, string> }> =
    [
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 403, headers: { 'retry-after': '60' } },
      { status: 429, headers: {} },
    ];
  for (const init of rateLimited) {
    const { fetcher } = recorder(() => reply(init));
    const card = await new GithubService(fetcher).getRepo('octocat', 'x');
    assert.deepEqual(card, {
      state: 'unavailable',
      fullName: 'octocat/x',
      url: 'https://github.com/octocat/x',
      reason: 'rate-limited',
    });
  }

  // Quota left: an ordinary 403 is still the private state.
  const { fetcher } = recorder(() =>
    reply({ status: 403, headers: { 'x-ratelimit-remaining': '57' } }),
  );
  assert.equal(
    (await new GithubService(fetcher).getRepo('octocat', 'x')).state,
    'private',
  );
});

test('the request is abandoned after the timeout: unavailable(timeout)', async () => {
  // A fetcher that answers only when aborted — the real hang.
  const { fetcher, calls } = recorder(
    (_url, init) =>
      new Promise<RepoResponse>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
  );
  const service = new GithubService(fetcher, { timeoutMs: 20 });
  const card = await service.getRepo('octocat', 'slow');

  assert.deepEqual(card, {
    state: 'unavailable',
    fullName: 'octocat/slow',
    url: 'https://github.com/octocat/slow',
    reason: 'timeout',
  });
  assert.equal(calls.length, 1);
});

test('network errors and unusable bodies are unavailable(error), never a throw', async () => {
  const failures: Handler[] = [
    () => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    },
    () => reply({ status: 500 }),
    () => reply({ status: 502 }),
    () => ({
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    }),
  ];
  for (const handler of failures) {
    const { fetcher } = recorder(handler);
    const card = await new GithubService(fetcher).getRepo('octocat', 'x');
    assert.deepEqual(card, {
      state: 'unavailable',
      fullName: 'octocat/x',
      url: 'https://github.com/octocat/x',
      reason: 'error',
    });
  }
});

// --- caching --------------------------------------------------------------

test('a cache hit costs no upstream call, and case never doubles the cost', async () => {
  const { fetcher, calls } = recorder(() =>
    reply({ status: 200, body: REPO_BODY }),
  );
  const service = new GithubService(fetcher);

  const first = await service.getRepo('octocat', 'Hello-World');
  const second = await service.getRepo('octocat', 'Hello-World');
  // GitHub is case-insensitive; the cache key is too.
  const third = await service.getRepo('OctoCat', 'hello-world');

  assert.equal(calls.length, 1, 'one upstream request for three reads');
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);

  // Clearing the cache goes upstream again (and only then).
  service.clearCache();
  await service.getRepo('octocat', 'Hello-World');
  assert.equal(calls.length, 2);
});

test('concurrent reads of one repo share a single in-flight request', async () => {
  let release!: (value: RepoResponse) => void;
  const { fetcher, calls } = recorder(
    () => new Promise<RepoResponse>((resolve) => (release = resolve)),
  );
  const service = new GithubService(fetcher);

  const reads = [
    service.getRepo('octocat', 'Hello-World'),
    service.getRepo('octocat', 'Hello-World'),
    service.getRepo('OCTOCAT', 'HELLO-WORLD'),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  release(reply({ status: 200, body: REPO_BODY }));

  const cards = await Promise.all(reads);
  assert.equal(calls.length, 1, 'three placements, one upstream call');
  assert.equal(new Set(cards.map((card) => card.state)).size, 1);
});

test('TTL differs by state: public 1h, private 6h, unavailable 5min', async () => {
  let clock = 1_000_000;
  const now = () => clock;

  const cases: Array<{
    handler: Handler;
    state: RepoCard['state'];
    ttl: number;
  }> = [
    {
      handler: () => reply({ status: 200, body: REPO_BODY }),
      state: 'public',
      ttl: PUBLIC_TTL_MS,
    },
    { handler: () => reply({ status: 404 }), state: 'private', ttl: PRIVATE_TTL_MS },
    {
      handler: () => reply({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      state: 'unavailable',
      ttl: UNAVAILABLE_TTL_MS,
    },
  ];

  for (const { handler, state, ttl } of cases) {
    const { fetcher, calls } = recorder(handler);
    const service = new GithubService(fetcher, { now });

    assert.equal((await service.getRepo('octocat', 'x')).state, state);
    assert.equal(calls.length, 1);

    // One millisecond before expiry: still cached.
    clock += ttl - 1;
    await service.getRepo('octocat', 'x');
    assert.equal(calls.length, 1, `${state} still cached just before its TTL`);

    // Past it: one more upstream call.
    clock += 2;
    await service.getRepo('octocat', 'x');
    assert.equal(calls.length, 2, `${state} refetched after its TTL`);
  }

  // The three TTLs really are different, in the intended order.
  assert.ok(UNAVAILABLE_TTL_MS < PUBLIC_TTL_MS);
  assert.ok(PUBLIC_TTL_MS < PRIVATE_TTL_MS);
  assert.equal(UNAVAILABLE_TTL_MS, 5 * 60 * 1000);
  assert.equal(PUBLIC_TTL_MS, 60 * 60 * 1000);
  assert.equal(PRIVATE_TTL_MS, 6 * 60 * 60 * 1000);
});

// --- credentials ----------------------------------------------------------

test('GITHUB_TOKEN rides as a Bearer header only when set, and is never logged', async () => {
  const secret = 'test-bearer-value-123';

  await withToken(undefined, async () => {
    const { fetcher, calls } = recorder(() =>
      reply({ status: 200, body: REPO_BODY }),
    );
    await new GithubService(fetcher).getRepo('octocat', 'x');
    assert.equal(calls[0].headers.authorization, undefined, 'no token, no header');
    assert.ok(calls[0].headers['user-agent'], 'User-Agent is always sent');
  });

  await withToken(secret, async () => {
    const { fetcher, calls } = recorder(() =>
      reply({ status: 200, body: REPO_BODY }),
    );
    await new GithubService(fetcher).getRepo('octocat', 'x');
    assert.equal(calls[0].headers.authorization, `Bearer ${secret}`);
    // The URL is built from the params alone — no credential in the path.
    assert.equal(calls[0].url, 'https://api.github.com/repos/octocat/x');
  });

  // Nothing the service writes, on any path, contains the token.
  await withToken(secret, async () => {
    const output = await captureOutput(async () => {
      const { fetcher } = recorder(() => {
        throw new Error(`connect ECONNREFUSED (token ${secret} in scope)`);
      });
      const service = new GithubService(fetcher);
      await service.getRepo('octocat', 'x');
      await service.getRepo('octocat', 'gone');
    });
    assert.equal(output.includes(secret), false, 'token never reaches a log');
    assert.equal(output.toLowerCase().includes('bearer'), false);
  });
});

// --- route params ---------------------------------------------------------

test('route params take the same reference gate as the page field', () => {
  assert.deepEqual(validateRepoParams('betterjam', 'eleva-aws-infra-control'), {
    owner: 'betterjam',
    name: 'eleva-aws-infra-control',
  });

  const rejected: Array<[unknown, unknown]> = [
    ['owner', 'repo/extra'],
    ['owner/extra', 'repo'],
    ['..', '..'],
    ['.', '.'],
    ['owner', ''],
    ['', 'repo'],
    ['owner name', 'repo'],
    ['owner', 'repo name'],
    ['owner', '../../users/octocat'],
    ['owner', 'repo?tab=x'],
    [undefined, 'repo'],
    ['owner', 7],
  ];
  for (const [owner, name] of rejected) {
    assert.throws(
      () => validateRepoParams(owner, name),
      BadRequestException,
      `${String(owner)}/${String(name)} should be rejected`,
    );
  }
});

test('a bad reference reaching the service never becomes an upstream call', async () => {
  const { fetcher, calls } = recorder(() => reply({ status: 200 }));
  const card = await new GithubService(fetcher).getRepo('..', '..');
  assert.equal(card.state, 'unavailable');
  assert.equal(calls.length, 0, 'nothing unvalidated is interpolated upstream');
});
