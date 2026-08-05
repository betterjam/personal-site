import { OnApplicationShutdown } from '@nestjs/common';
import { EventStore, NewEvent, StoredEvent } from './event-store';

/**
 * The slice of `pg.Pool` this store uses. Narrowed to an interface so unit
 * tests can substitute a stub pool and assert on the SQL without a live
 * database; `pg.Pool` satisfies it structurally.
 */
export interface PgPoolLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS blog_events (
  seq bigserial PRIMARY KEY,
  type text NOT NULL,
  at timestamptz NOT NULL,
  data jsonb NOT NULL
)`;

export const INSERT_SQL =
  'INSERT INTO blog_events (type, at, data) VALUES ($1, $2, $3) RETURNING seq';

export const SELECT_ALL_SQL =
  'SELECT seq, type, at, data FROM blog_events ORDER BY seq ASC';

/**
 * Append-only event store on a single Postgres table. `seq` is a bigserial
 * assigned by the database, so concurrent app instances can append without
 * coordinating (unlike the file store's in-process queue). The table is
 * created lazily on first use (CREATE TABLE IF NOT EXISTS), and the pool is
 * closed on application shutdown so Nest exits cleanly.
 */
export class PostgresEventStore implements EventStore, OnApplicationShutdown {
  private initPromise: Promise<void> | null = null;

  constructor(private readonly pool: PgPoolLike) {}

  async append(event: NewEvent): Promise<StoredEvent> {
    await this.init();
    const at = event.at ?? new Date().toISOString();
    // jsonb param is stringified explicitly: node-postgres would serialize a
    // plain object itself but mangles top-level arrays into Postgres arrays.
    const { rows } = await this.pool.query(INSERT_SQL, [
      event.type,
      at,
      JSON.stringify(event.data ?? null),
    ]);
    return {
      seq: toSeqNumber(rows[0]?.seq),
      type: event.type,
      at,
      data: event.data,
    };
  }

  async *readAll(): AsyncIterable<StoredEvent> {
    await this.init();
    const { rows } = await this.pool.query(SELECT_ALL_SQL);
    for (const row of rows) {
      yield rowToStoredEvent(row);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /** Ensures the table exists exactly once per store instance. */
  private init(): Promise<void> {
    this.initPromise ??= this.pool.query(CREATE_TABLE_SQL).then(() => undefined);
    return this.initPromise;
  }
}

/** bigserial comes back from `pg` as a string; the contract wants a number. */
function toSeqNumber(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`postgres returned an invalid seq: ${String(value)}`);
  }
  return seq;
}

function rowToStoredEvent(row: Record<string, unknown>): StoredEvent {
  const at = row.at;
  return {
    seq: toSeqNumber(row.seq),
    type: String(row.type),
    at: at instanceof Date ? at.toISOString() : String(at),
    data: row.data,
  };
}
