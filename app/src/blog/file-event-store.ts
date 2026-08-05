import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { EventStore, NewEvent, StoredEvent } from './event-store';

/**
 * Append-only JSONL event store: one JSON object per line,
 * `{seq, type, at, data}`. Appends are serialized through an internal
 * promise chain so concurrent writers never interleave lines; the last
 * sequence number is discovered lazily by scanning the file once.
 */
export class FileEventStore implements EventStore {
  private lastSeq: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(event: NewEvent): Promise<StoredEvent> {
    const result = this.queue.then(async () => {
      if (this.lastSeq === null) {
        this.lastSeq = await this.scanLastSeq();
      }
      const stored: StoredEvent = {
        seq: this.lastSeq + 1,
        type: event.type,
        at: event.at ?? new Date().toISOString(),
        data: event.data,
      };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(stored)}\n`, 'utf8');
      this.lastSeq = stored.seq;
      return stored;
    });
    // Keep the chain alive even if this append rejects.
    this.queue = result.catch(() => undefined);
    return result;
  }

  async *readAll(): AsyncIterable<StoredEvent> {
    try {
      await fs.access(this.filePath);
    } catch {
      return; // no log yet: empty stream
    }
    const rl = readline.createInterface({
      input: createReadStream(this.filePath, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      yield JSON.parse(trimmed) as StoredEvent;
    }
  }

  private async scanLastSeq(): Promise<number> {
    let last = 0;
    for await (const event of this.readAll()) {
      last = event.seq;
    }
    return last;
  }
}
