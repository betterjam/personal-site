import { Controller, Get } from '@nestjs/common';
import { MetaService, MetaView } from './meta.service';

@Controller('meta')
export class MetaController {
  constructor(private readonly meta: MetaService) {}

  @Get()
  get(): MetaView {
    return this.meta.getMeta();
  }
}
