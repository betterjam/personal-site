import { Module } from '@nestjs/common';
import { GithubController } from './github.controller';
import { GithubService } from './github.service';
import { createRepoFetcher, REPO_FETCHER } from './repo-fetcher';

/**
 * The repo widget's only server-side dependency. It owns no event stream
 * and no store — a repo's stars and visibility are upstream state, not
 * something the site could replay — so unlike the other modules this one
 * imports nothing and holds a plain in-memory TTL cache.
 *
 * The fetcher is a provider rather than a direct `fetch` call so tests
 * cover every upstream branch without a live request.
 */
@Module({
  controllers: [GithubController],
  providers: [
    { provide: REPO_FETCHER, useFactory: createRepoFetcher },
    GithubService,
  ],
})
export class GithubModule {}
