import { liveDeps } from './aws';
import { createHandler } from './handler';
import { ControlEvent } from './types';

/**
 * Lambda entry point for control.diegopalominos.dev.
 *
 * The real AWS ports are built on the first invocation (not at module load)
 * so that `handler.ts` stays importable — and unit-testable with `node:test`
 * — without any `@aws-sdk/*` package present.
 */
let cached: ReturnType<typeof createHandler> | undefined;

export const handler = async (event: ControlEvent) => {
  cached ??= createHandler(liveDeps());
  return cached(event);
};
