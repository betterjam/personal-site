import { Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Tagging (F6).
 *
 * Every resource this app creates carries the same three tags, so that in an
 * account shared with production Eleva you can always answer "is this mine or
 * the school's?" with a filter — in Cost Explorer, in the console, in a future
 * SCP, and in the clean-up script if the playground is ever retired.
 *
 * `project` is also the cost-allocation tag the monthly budget filters on
 * (F7). It must be *activated* once in Billing → Cost allocation tags before
 * the budget can see it; see the README runbook.
 */
export const PROJECT_TAGS: Record<string, string> = {
  project: 'diego-site',
  owner: 'diego',
  exposure: 'public-demo',
};

/** Cost-allocation tag the budget filters on. */
export const COST_TAG_KEY = 'project';
/** Cost-allocation tag value the budget filters on. */
export const COST_TAG_VALUE = PROJECT_TAGS[COST_TAG_KEY];

/** Apply {@link PROJECT_TAGS} to a scope — normally the `App`. */
export function applyProjectTags(scope: IConstruct): void {
  for (const [key, value] of Object.entries(PROJECT_TAGS)) {
    Tags.of(scope).add(key, value);
  }
}
