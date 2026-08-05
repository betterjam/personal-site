import { Module } from '@nestjs/common';
import { BlogModule } from '../blog/blog.module';
import { DeploysProjection } from './deploys.projection';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

/**
 * Deploy metadata rides the same append-only log as the blog, so the store
 * is injected from BlogModule rather than opened twice (two FileEventStore
 * instances on one file would race on seq assignment). Importing BlogModule
 * also makes Nest run the blog replay/seed before MetaService records a
 * deploy, keeping first-boot log order deterministic.
 */
@Module({
  imports: [BlogModule],
  controllers: [MetaController],
  providers: [DeploysProjection, MetaService],
})
export class MetaModule {}
