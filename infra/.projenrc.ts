import { awscdk, javascript } from 'projen';

// TypeScript CDK v2 app managed by projen.
// `npx projen && npm run build`, then `npx cdk deploy`.
const project = new awscdk.AwsCdkTypeScriptApp({
  name: 'personal-site-infra',
  cdkVersion: '2.170.0', // CDK v2, floor-pinned within the v2 line
  defaultReleaseBranch: 'main',
  packageManager: javascript.NodePackageManager.NPM,
  projenrcTs: true,
  minNodeVersion: '22.0.0',

  // Match the repo root LICENSE. infra/LICENSE is generated from this — do not
  // hand-edit it, it is written read-only and `npx projen` clobbers it.
  license: 'MIT',
  copyrightOwner: 'Diego Palominos',
  copyrightPeriod: '2026',

  // This project lives inside the personal-site repo; no standalone GitHub
  // workflows / mergify config of its own.
  github: false,

  /*
   * MUST NOT be removed. `cdk.context.json` caches AWS account ids, VPC ids,
   * subnet ids, route-table ids, hosted-zone ids and AMI ids — a ready-made
   * map of the account — and this repo is public. AWS's own CDK docs recommend
   * committing this file; for a public repo that advice is wrong. The repo
   * root .gitignore carries the same rule as a backstop in case this project
   * is ever moved or re-synthesized.
   */
  gitignore: ['cdk.context.json'],
});

/*
 * Never publishable. Without this, `npm publish` from infra/ would push this
 * package to the public npm registry (the generated package.json otherwise
 * carries `publishConfig.access: public` and no `private` flag).
 */
project.package.addField('private', true);

/*
 * The control Lambda's own unit tests.
 *
 * jest owns the CDK assertions (`test/*.test.ts`); the Lambda handler is plain
 * TypeScript with injected ports, so it is tested with `node:test` against
 * in-memory stubs — no jest environment, no AWS SDK, no credentials. The
 * `.nodetest.ts` suffix keeps jest's testMatch from picking these up, and the
 * task is spawned from `test` so `npm run build` runs both suites.
 */
const controlHandlerTests = project.addTask('test:control', {
  description: 'node:test unit tests for the control Lambda handler (stubbed AWS clients)',
  exec: 'ts-node -P test/tsconfig.json test/control-handler.nodetest.ts',
});
project.testTask.spawn(controlHandlerTests);

project.synth();
