import { App } from 'aws-cdk-lib';
import { DiegoSiteStack } from '../src/diego-site-stack';
import { ElevaBlogStack } from '../src/eleva-blog-stack';

/**
 * The stack used to be `ElevaBlogStack`. `src/eleva-blog-stack.ts` is now a
 * one-line re-export so older references keep compiling; the real suite is
 * `test/diego-site-stack.test.ts`.
 */
describe('eleva-blog-stack compatibility shim', () => {
  test('ElevaBlogStack is DiegoSiteStack', () => {
    expect(ElevaBlogStack).toBe(DiegoSiteStack);
  });

  test('it still constructs under the old name', () => {
    const app = new App({ context: { expectedAccount: '111122223333' } });
    const stack = new ElevaBlogStack(app, 'DiegoSiteStack');
    expect(stack.siteUrl).toBeDefined();
  });
});
