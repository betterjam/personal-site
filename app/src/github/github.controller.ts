import { Controller, Get, Param } from '@nestjs/common';
import { GithubService, RepoCard } from './github.service';
import { validateRepoParams } from './validate';

/**
 * Public read-only proxy in front of api.github.com. Public because the
 * widget is public; a proxy at all because the browser must not spend the
 * visitor's own GitHub quota, must not learn a token, and must get the
 * same cached answer everyone else gets.
 *
 * Malformed params are the only 400 here. Everything else — private repo,
 * rate limit, upstream down — is a 200 carrying a state the widget knows
 * how to draw.
 */
@Controller('github')
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Get(':owner/:repo')
  get(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<RepoCard> {
    const params = validateRepoParams(owner, repo);
    return this.github.getRepo(params.owner, params.name);
  }
}
