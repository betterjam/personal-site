import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { blogEventsPath } from '../config/paths';
import { AdminGuard } from './admin.guard';
import { BlogAdminController, BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { EVENT_STORE, EventStore } from './event-store';
import { FileEventStore } from './file-event-store';
import { PostgresEventStore } from './postgres-event-store';
import { PostsProjection } from './posts.projection';

/**
 * EVENT_STORE=postgres selects the Postgres store (connection string from
 * DATABASE_URL); anything else (or unset) keeps the JSONL file store. The
 * PostgresEventStore closes its pool via onApplicationShutdown, which Nest
 * invokes on factory-provided instances because main.ts enables shutdown
 * hooks.
 */
export function createEventStore(env: NodeJS.ProcessEnv): EventStore {
  if (env.EVENT_STORE === 'postgres') {
    const url = env.DATABASE_URL;
    if (!url) {
      throw new Error('EVENT_STORE=postgres requires DATABASE_URL to be set');
    }
    return new PostgresEventStore(new Pool({ connectionString: url }));
  }
  return new FileEventStore(blogEventsPath());
}

@Module({
  controllers: [BlogController, BlogAdminController],
  providers: [
    {
      provide: EVENT_STORE,
      useFactory: (): EventStore => createEventStore(process.env),
    },
    PostsProjection,
    BlogService,
    AdminGuard,
  ],
  // The store is shared with MetaModule and PagesModule (deploy and page
  // events live in the same append-only log, namespaced by event type).
  // PostsProjection is exported for PagesModule's cross-namespace slug check.
  exports: [EVENT_STORE, PostsProjection],
})
export class BlogModule {}
