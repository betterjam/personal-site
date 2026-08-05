import { BadRequestException } from '@nestjs/common';
import { isValidRepoRef } from '../common/repo-ref';

export interface RepoParams {
  owner: string;
  name: string;
}

/**
 * Gate for GET /api/github/:owner/:repo. The two path segments are the only
 * caller-controlled part of the upstream URL, so they are checked against
 * the SAME reference format a page's `repo` field must satisfy — anything
 * else is a 400 and never reaches the network.
 */
export function validateRepoParams(owner: unknown, name: unknown): RepoParams {
  if (typeof owner !== 'string' || typeof name !== 'string') {
    throw new BadRequestException({ error: 'owner and repo must be strings' });
  }
  if (!isValidRepoRef(`${owner}/${name}`)) {
    throw new BadRequestException({
      error: 'owner and repo must form an owner/name reference',
    });
  }
  return { owner, name };
}
