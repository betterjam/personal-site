import { Module } from '@nestjs/common';
import { AdminGuard } from '../blog/admin.guard';
import { BlogModule } from '../blog/blog.module';
import { PagesAdminController, PagesController } from './pages.controller';
import { PagesProjection } from './pages.projection';
import { PagesService } from './pages.service';

/**
 * Pages ride the same append-only log as posts and deploys, so the store is
 * injected from BlogModule rather than opened twice (two FileEventStore
 * instances on one file would race on seq assignment). Importing BlogModule
 * also provides the PostsProjection for the cross-namespace slug check and
 * makes Nest run the blog replay/seed before the pages replay, keeping boot
 * order deterministic.
 */
@Module({
  imports: [BlogModule],
  controllers: [PagesController, PagesAdminController],
  providers: [PagesProjection, PagesService, AdminGuard],
})
export class PagesModule {}
