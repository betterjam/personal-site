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
import { AdminGuard } from './admin.guard';
import { BlogService } from './blog.service';
import { StoredEvent } from './event-store';
import { PostView } from './posts.projection';
import { validateNewPost, validateRevision } from './validate';

/** Public reads (published posts only) + admin-guarded writes. */
@Controller('posts')
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Get()
  list(): PostView[] {
    return this.blog.listPublished();
  }

  @Get(':slug')
  get(@Param('slug') slug: string): PostView {
    return this.blog.getPublished(slug);
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() payload: unknown): Promise<PostView> {
    return this.blog.createPost(validateNewPost(payload));
  }

  @Patch(':slug')
  @UseGuards(AdminGuard)
  revise(
    @Param('slug') slug: string,
    @Body() payload: unknown,
  ): Promise<PostView> {
    return this.blog.revisePost(slug, validateRevision(payload));
  }

  @Post(':slug/publish')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  publish(@Param('slug') slug: string): Promise<PostView> {
    return this.blog.publishPost(slug);
  }

  @Post(':slug/unpublish')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  unpublish(@Param('slug') slug: string): Promise<PostView> {
    return this.blog.unpublishPost(slug);
  }
}

/** Admin-only reads: every status, plus a slug's raw event history. */
@Controller('admin/posts')
@UseGuards(AdminGuard)
export class BlogAdminController {
  constructor(private readonly blog: BlogService) {}

  @Get()
  listAll(): PostView[] {
    return this.blog.listAll();
  }

  @Get(':slug')
  getAny(@Param('slug') slug: string): PostView {
    return this.blog.getAny(slug);
  }

  @Get(':slug/events')
  events(@Param('slug') slug: string): Promise<StoredEvent[]> {
    return this.blog.getEvents(slug);
  }
}
