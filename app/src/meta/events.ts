/**
 * Deploy events share the blog's append-only log; the event `type` is the
 * namespace that keeps the streams apart. The posts projection ignores
 * `DeployRecorded` (unknown type to it) and the deploys projection ignores
 * post events, so each read model folds only its own slice of the log.
 */
export const DEPLOY_RECORDED = 'DeployRecorded';

export interface DeployRecordedData {
  /** Git commit sha of the deployed build. */
  sha: string;
  /** ISO timestamp the build was stamped/deployed. */
  at: string;
}
