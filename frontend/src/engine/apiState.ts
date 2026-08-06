/**
 * IS THE API AWAKE? — one answer, shared by every surface that shows it.
 *
 * This site is designed to run with its infrastructure switched off, so
 * "the API is not answering" is a NORMAL state here, not an error. What
 * matters everywhere is the distinction this module draws:
 *
 *   THE API SAID NO      — it answered, in its own JSON voice: 404 for a
 *                          page that is unpublished or unknown. That is a
 *                          real editorial state and it must be obeyed: the
 *                          page disappears.
 *   THE API SAID NOTHING — the request never reached it, or something
 *                          that is not the API answered instead: a network
 *                          failure, a timeout, a 5xx from the load
 *                          balancer, an HTML error page from the CDN. That
 *                          is silence, and silence must NEVER empty the
 *                          site — the bundled snapshot answers instead.
 *
 * classify() is where that line is drawn, once. A response only counts as
 * the API's own voice when it is JSON: a 404 of text/html is a static host
 * saying "no such file", not the API saying "no such page", and treating
 * the two alike is exactly how a switched-off backend used to delete the
 * Projects section.
 *
 * The state is observable so the hub banner can say "asleep — switch it
 * back on" and take that line away again the moment the API answers,
 * without a reload. Recovery is watched POLITELY: nothing polls while the
 * API is live, nothing polls while the tab is hidden, and the interval is
 * a minute-ish, not a heartbeat.
 */

/** 'unknown' until the first call settles — the banner stays quiet then. */
export type ApiState = 'unknown' | 'live' | 'asleep';

/** How long any read waits before deciding it heard silence. */
export const API_TIMEOUT_MS = 6000;

/** How often a sleeping API is re-checked, while the tab is in front. */
const WATCH_MS = 45_000;

let state: ApiState = 'unknown';
const listeners = new Set<(next: ApiState) => void>();

export function apiState(): ApiState {
  return state;
}

/** True once we have heard silence — the banner's own condition. */
export function apiAsleep(): boolean {
  return state === 'asleep';
}

/** Subscribe to changes; returns the unsubscribe. Never fires on no-ops. */
export function onApiState(fn: (next: ApiState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setState(next: ApiState): void {
  if (next === state) return;
  state = next;
  for (const fn of [...listeners]) fn(state);
  schedule();
}

/**
 * Every read reports what it heard. `reachable` means the API itself
 * answered — including a perfectly good 404.
 */
export function reportApi(reachable: boolean): void {
  setState(reachable ? 'live' : 'asleep');
}

/* ----------------------------------------------------------- classify */

/** What one response was, in the terms this whole module is about. */
export type ApiAnswer = 'ok' | 'absent' | 'silent';

function isJson(res: Response): boolean {
  const type = res.headers.get('content-type') ?? '';
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(type.trim());
}

/**
 * 'ok'     — the API answered with content (2xx JSON).
 * 'absent' — the API answered that there is nothing here (404 JSON).
 * 'silent' — anything else: a 5xx, a 4xx that is not a JSON 404, or a body
 *            that is not JSON at all (an HTML error page, an SPA fallback).
 * Reporting is a side effect on purpose: one call site per read, and the
 * banner is never out of step with what the reads are seeing.
 */
export function classify(res: Response): ApiAnswer {
  const json = isJson(res);
  if (json && res.ok) {
    reportApi(true);
    return 'ok';
  }
  if (json && res.status === 404) {
    reportApi(true);
    return 'absent';
  }
  reportApi(false);
  return 'silent';
}

/** A request that gives up rather than hanging a skeleton row forever. */
export function apiSignal(ms: number = API_TIMEOUT_MS): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/* -------------------------------------------------------------- probe */

let probing: Promise<void> | null = null;

/**
 * One cheap knock on the door: /api/meta is the smallest public read
 * there is. Shared while in flight, and it only ever updates the state —
 * callers who want the payload use fetchMeta().
 */
export function probeApi(): Promise<void> {
  if (probing) return probing;
  probing = fetch('/api/meta', {
    headers: { accept: 'application/json' },
    signal: apiSignal(),
  })
    .then((res) => {
      classify(res);
    })
    .catch(() => {
      reportApi(false);
    })
    .finally(() => {
      probing = null;
    });
  return probing;
}

/* -------------------------------------------------------------- watch */

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** The timer exists only while someone is watching a SLEEPING API in view. */
function schedule(): void {
  const wanted =
    watchers > 0 && state === 'asleep' && document.visibilityState !== 'hidden';
  if (!wanted) {
    stopTimer();
    return;
  }
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void probeApi().then(schedule);
  }, WATCH_MS);
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    stopTimer();
    return;
  }
  /* back in front: ask once, right away, then fall back to the interval */
  if (watchers > 0 && state === 'asleep') void probeApi();
  schedule();
}

/**
 * Watch for recovery. Ref-counted: the hub banner takes one for the life
 * of the page, and the returned function releases it. Idle by
 * construction — no timer while the API is live or the tab is hidden.
 */
export function watchApi(): () => void {
  watchers += 1;
  if (watchers === 1) document.addEventListener('visibilitychange', onVisibility);
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers -= 1;
    if (watchers === 0) {
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimer();
    }
  };
}
