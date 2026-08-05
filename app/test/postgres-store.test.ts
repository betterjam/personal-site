import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventStore } from '../src/blog/blog.module';
import { FileEventStore } from '../src/blog/file-event-store';
import {
  CREATE_TABLE_SQL,
  INSERT_SQL,
  PgPoolLike,
  PostgresEventStore,
  SELECT_ALL_SQL,
} from '../src/blog/postgres-event-store';

/** Records every query; answers from a scripted row source. No live DB. */
class StubPool implements PgPoolLike {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];
  ended = false;

  constructor(
    private readonly respond: (
      text: string,
      values?: unknown[],
    ) => Record<string, unknown>[] = () => [],
  ) {}

  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values });
    return Promise.resolve({ rows: this.respond(text, values) });
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

test('append creates the table once, then INSERTs with RETURNING seq', async () => {
  const pool = new StubPool((text) =>
    text === INSERT_SQL ? [{ seq: '41' }] : [],
  );
  const store = new PostgresEventStore(pool);

  const stored = await store.append({
    type: 'PostDrafted',
    at: '2026-08-05T10:00:00.000Z',
    data: { slug: 'x', title: 'X', deck: 'd', tags: [] },
  });

  // bigserial comes back as a string; the store hands out a number.
  assert.equal(stored.seq, 41);
  assert.equal(stored.type, 'PostDrafted');
  assert.equal(stored.at, '2026-08-05T10:00:00.000Z');

  assert.deepEqual(
    pool.calls.map((call) => call.text),
    [CREATE_TABLE_SQL, INSERT_SQL],
  );
  const insert = pool.calls[1];
  assert.deepEqual(insert.values, [
    'PostDrafted',
    '2026-08-05T10:00:00.000Z',
    JSON.stringify({ slug: 'x', title: 'X', deck: 'd', tags: [] }),
  ]);

  // Second append: table creation is not repeated.
  await store.append({ type: 'B', at: '2026-08-05T11:00:00.000Z', data: {} });
  assert.deepEqual(
    pool.calls.map((call) => call.text),
    [CREATE_TABLE_SQL, INSERT_SQL, INSERT_SQL],
  );
});

test('append defaults `at` to now (ISO)', async () => {
  const pool = new StubPool((text) => (text === INSERT_SQL ? [{ seq: 1 }] : []));
  const store = new PostgresEventStore(pool);
  const before = Date.now();
  const stored = await store.append({ type: 'T', data: {} });
  assert.ok(Date.parse(stored.at) >= before - 1000);
  assert.equal(pool.calls[1].values?.[1], stored.at);
});

test('readAll SELECTs ordered by seq and maps pg row types back', async () => {
  const rows = [
    {
      seq: '1',
      type: 'PostDrafted',
      at: new Date('2026-01-01T09:00:00.000Z'), // timestamptz -> Date
      data: { slug: 'a', title: 'A', deck: 'd', tags: [] }, // jsonb -> object
    },
    {
      seq: '2',
      type: 'DeployRecorded',
      at: new Date('2026-01-02T09:00:00.000Z'),
      data: { sha: 'abc', at: '2026-01-02T09:00:00.000Z' },
    },
  ];
  const pool = new StubPool((text) => (text === SELECT_ALL_SQL ? rows : []));
  const store = new PostgresEventStore(pool);

  const events = [];
  for await (const event of store.readAll()) {
    events.push(event);
  }

  assert.deepEqual(
    pool.calls.map((call) => call.text),
    [CREATE_TABLE_SQL, SELECT_ALL_SQL],
  );
  assert.deepEqual(events, [
    {
      seq: 1,
      type: 'PostDrafted',
      at: '2026-01-01T09:00:00.000Z',
      data: { slug: 'a', title: 'A', deck: 'd', tags: [] },
    },
    {
      seq: 2,
      type: 'DeployRecorded',
      at: '2026-01-02T09:00:00.000Z',
      data: { sha: 'abc', at: '2026-01-02T09:00:00.000Z' },
    },
  ]);
});

test('append rejects on a nonsensical RETURNING seq', async () => {
  const pool = new StubPool((text) =>
    text === INSERT_SQL ? [{ seq: 'not-a-number' }] : [],
  );
  const store = new PostgresEventStore(pool);
  await assert.rejects(() => store.append({ type: 'T', data: {} }), /invalid seq/);
});

test('onApplicationShutdown closes the pool', async () => {
  const pool = new StubPool();
  const store = new PostgresEventStore(pool);
  await store.onApplicationShutdown();
  assert.equal(pool.ended, true);
});

test('createEventStore selects the store from the environment', async () => {
  assert.ok(createEventStore({}) instanceof FileEventStore);
  assert.ok(
    createEventStore({ EVENT_STORE: 'file-ish-nonsense' }) instanceof
      FileEventStore,
  );

  const pgStore = createEventStore({
    EVENT_STORE: 'postgres',
    DATABASE_URL: 'postgres://placeholder:placeholder@localhost:5432/placeholder',
  });
  assert.ok(pgStore instanceof PostgresEventStore);
  // Release the (never-connected) pg pool so node:test can exit cleanly.
  await (pgStore as PostgresEventStore).onApplicationShutdown();

  assert.throws(
    () => createEventStore({ EVENT_STORE: 'postgres' }),
    /DATABASE_URL/,
  );
});
