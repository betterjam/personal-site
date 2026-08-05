import { Controller, Get, Param } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('content')
  getContent(): Promise<unknown> {
    return this.content.getContent();
  }

  @Get('themes')
  listThemes(): Promise<string[]> {
    return this.content.listThemes();
  }

  @Get('themes/:id')
  getTheme(@Param('id') id: string): Promise<unknown> {
    return this.content.getTheme(id);
  }
}
