/**
 * Append-only event store contract for the blog stream.
 *
 * Two implementations exist behind this interface: the JSONL FileEventStore
 * (default, local dev) and the PostgresEventStore (single `blog_events`
 * table with a bigserial `seq`, selected with EVENT_STORE=postgres).
 * Projection and service code never see which one is wired in.
 */

export interface NewEvent<T = unknown> {
  type: string;
  data: T;
  /** ISO timestamp; defaults to now. */
  at?: string;
}

export interface StoredEvent<T = unknown> {
  /** 1-based, monotonically increasing, assigned by the store. */
  seq: number;
  type: string;
  /** ISO timestamp. */
  at: string;
  data: T;
}

export interface EventStore {
  /** Durably appends one event and returns it with its assigned seq. */
  append(event: NewEvent): Promise<StoredEvent>;
  /** Streams every stored event in seq order. */
  readAll(): AsyncIterable<StoredEvent>;
}

/** Injection token for the blog EventStore implementation. */
export const EVENT_STORE = 'BLOG_EVENT_STORE';
