import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../blog/admin.guard';
import { StoredEvent } from '../blog/event-store';
import { PageView } from './pages.projection';
import { PageSummary, PagesService } from './pages.service';
import { validateNewPage, validatePageRevision } from './validate';

/** Public reads (published pages only) + admin-guarded writes. */
@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  list(): PageSummary[] {
    return this.pages.listPublished();
  }

  @Get(':slug')
  get(@Param('slug') slug: string): PageView {
    return this.pages.getPublished(slug);
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() payload: unknown): Promise<PageView> {
    return this.pages.createPage(validateNewPage(payload));
  }

  @Patch(':slug')
  @UseGuards(AdminGuard)
  revise(
    @Param('slug') slug: string,
    @Body() payload: unknown,
  ): Promise<PageView> {
    return this.pages.revisePage(slug, validatePageRevision(payload));
  }

  @Post(':slug/publish')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  publish(@Param('slug') slug: string): Promise<PageView> {
    return this.pages.publishPage(slug);
  }

  @Post(':slug/unpublish')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  unpublish(@Param('slug') slug: string): Promise<PageView> {
    return this.pages.unpublishPage(slug);
  }
}

/** Admin-only reads: every status, plus a slug's raw event history. */
@Controller('admin/pages')
@UseGuards(AdminGuard)
export class PagesAdminController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  listAll(): PageView[] {
    return this.pages.listAll();
  }

  @Get(':slug')
  getAny(@Param('slug') slug: string): PageView {
    return this.pages.getAny(slug);
  }

  @Get(':slug/events')
  events(@Param('slug') slug: string): Promise<StoredEvent[]> {
    return this.pages.getEvents(slug);
  }
}
