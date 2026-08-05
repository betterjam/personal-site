import { Injectable } from '@nestjs/common';
import { StoredEvent } from '../blog/event-store';
import { DEPLOY_RECORDED, DeployRecordedData } from './events';

export interface DeployView {
  sha: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * In-memory read model of deploys folded from the shared event stream.
 * Like PostsProjection it is rebuildable by construction: restart =
 * reset() + replay. Every event type other than DeployRecorded is ignored,
 * so post events (and future streams) pass through untouched.
 */
@Injectable()
export class DeploysProjection {
  /** Log order: oldest first. */
  private readonly deploys: DeployView[] = [];

  apply(event: StoredEvent): void {
    if (event.type !== DEPLOY_RECORDED) return;
    const data = event.data as DeployRecordedData;
    this.deploys.push({ sha: data.sha, at: data.at ?? event.at });
  }

  reset(): void {
    this.deploys.length = 0;
  }

  /** Most recent deploy, if any. */
  latest(): DeployView | undefined {
    return this.deploys[this.deploys.length - 1];
  }

  /** The last `n` deploys, newest first. */
  lastN(n: number): DeployView[] {
    return this.deploys.slice(-n).reverse();
  }
}
