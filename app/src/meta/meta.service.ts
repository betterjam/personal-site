import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_STORE, EventStore } from '../blog/event-store';
import { DeploysProjection, DeployView } from './deploys.projection';
import { DEPLOY_RECORDED, DeployRecordedData } from './events';

export interface MetaView {
  commit: string;
  /** ISO timestamp. */
  builtAt: string;
  /** Last deploys, newest first. */
  deploys: DeployView[];
}

/** How many deploys /api/meta reports. */
const DEPLOYS_SHOWN = 5;

/** Captured once at module load; the builtAt fallback for dev runs. */
const PROCESS_START_ISO = new Date(
  Date.now() - Math.round(process.uptime() * 1000),
).toISOString();

@Injectable()
export class MetaService implements OnModuleInit {
  private readonly logger = new Logger(MetaService.name);

  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    private readonly projection: DeploysProjection,
  ) {}

  /**
   * Boot = replay the shared log into the deploys projection, then record
   * this deploy iff GIT_SHA is set and differs from the latest recorded sha
   * (restarts of the same build append nothing).
   */
  async onModuleInit(): Promise<void> {
    const replayed = await this.replay();
    this.logger.log(`Replayed ${replayed} event(s) into deploys projection`);
    const recorded = await this.recordDeployIfNew();
    if (recorded) {
      this.logger.log(`Recorded deploy ${recorded.sha}`);
    }
  }

  getMeta(): MetaView {
    return {
      commit: process.env.GIT_SHA || 'dev',
      builtAt: process.env.BUILD_TIME || PROCESS_START_ISO,
      deploys: this.projection.lastN(DEPLOYS_SHOWN),
    };
  }

  private async replay(): Promise<number> {
    this.projection.reset();
    let count = 0;
    for await (const event of this.store.readAll()) {
      this.projection.apply(event);
      count += 1;
    }
    return count;
  }

  private async recordDeployIfNew(): Promise<DeployView | undefined> {
    const sha = process.env.GIT_SHA;
    if (!sha || this.projection.latest()?.sha === sha) {
      return undefined;
    }
    const at = process.env.BUILD_TIME || new Date().toISOString();
    const data: DeployRecordedData = { sha, at };
    const stored = await this.store.append({ type: DEPLOY_RECORDED, data, at });
    this.projection.apply(stored);
    return { sha, at };
  }
}
