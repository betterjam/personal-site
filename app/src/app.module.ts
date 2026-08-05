import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { BlogModule } from './blog/blog.module';
import { publicDir } from './config/paths';
import { ContentModule } from './content/content.module';
import { GithubModule } from './github/github.module';
import { MetaModule } from './meta/meta.module';
import { PagesModule } from './pages/pages.module';

@Module({
  imports: [
    // Static frontend at /; /api/* is excluded so unknown API routes
    // return JSON 404s instead of the SPA fallback.
    ServeStaticModule.forRoot({
      rootPath: publicDir(),
      exclude: ['/api/{*splat}'],
    }),
    ContentModule,
    BlogModule,
    PagesModule,
    MetaModule,
    GithubModule,
  ],
})
export class AppModule {}
