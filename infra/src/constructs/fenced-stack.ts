import { Annotations, Fn, Stack, StackProps, Token } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Same-account fencing (F1–F5).
 *
 * This app deploys into an account that may also host unrelated production
 * workloads. That was a deliberate choice, on condition that the public
 * playground is fenced hard. This module is the first fence: nothing in this
 * app may synthesize — let alone deploy — into an account it was not told to
 * expect.
 *
 * The account number itself is deliberately NOT in source. Supply it per
 * invocation with `-c expectedAccount=<id>` or `CDK_EXPECTED_ACCOUNT=<id>`;
 * the local value lives in the gitignored `cdk.context.json`.
 */

/**
 * The one account this app deploys into — never hardcoded. Set it with
 * `-c expectedAccount=<id>` or the `CDK_EXPECTED_ACCOUNT` environment
 * variable. Empty means "not configured", and the fence refuses to resolve.
 */
export const EXPECTED_ACCOUNT = process.env.CDK_EXPECTED_ACCOUNT ?? '';
/** The one region this app deploys into. Override with `-c expectedRegion=`. */
export const EXPECTED_REGION = process.env.CDK_EXPECTED_REGION ?? 'us-east-1';
/** The error every unconfigured fence raises, so the fix is always on screen. */
export const UNCONFIGURED_ACCOUNT_ERROR =
  'This app refuses to synthesize unfenced: no expected AWS account is configured. '
  + 'Pass -c expectedAccount=<id> (or set CDK_EXPECTED_ACCOUNT=<id>). '
  + 'The value is deliberately not stored in source — keep it in the gitignored cdk.context.json.';
/**
 * Name prefixes of stacks in the same account that this app must never touch.
 * Supplied through context (`-c protectedStackPrefixes=a,b`) or
 * `CDK_PROTECTED_STACK_PREFIXES`, so no production stack name ships in source.
 * Empty is a valid configuration: it simply adds no name-based denies.
 */
export const PROTECTED_STACK_PREFIXES: string[] = splitPrefixes(process.env.CDK_PROTECTED_STACK_PREFIXES);

/** Parse a comma/space separated prefix list from context or environment. */
export function splitPrefixes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Protected stack prefixes for a scope: context first, then environment.
 * Nothing here may reference them, and the control plane's IAM boundary denies
 * them by name (F3).
 */
export function resolveProtectedStackPrefixes(scope: Construct): string[] {
  const fromContext = scope.node.tryGetContext('protectedStackPrefixes');
  const resolved = splitPrefixes(fromContext);
  return resolved.length > 0 ? resolved : PROTECTED_STACK_PREFIXES;
}

/** Resolved fence for a scope: context values with the documented defaults. */
export interface Fence {
  readonly account: string;
  readonly region: string;
}

/**
 * Read `expectedAccount` / `expectedRegion` from context (App-level or
 * `cdk.json`), then the environment. There is no built-in account default:
 * an unconfigured fence throws rather than guessing.
 */
export function resolveFence(scope: Construct): Fence {
  const account: string = scope.node.tryGetContext('expectedAccount') ?? EXPECTED_ACCOUNT;
  if (!account) throw new Error(UNCONFIGURED_ACCOUNT_ERROR);
  return {
    account,
    region: scope.node.tryGetContext('expectedRegion') ?? EXPECTED_REGION,
  };
}

/**
 * Base class for every stack in this app.
 *
 * What it adds:
 *
 * 1. **Account guard (F1).** If the stack resolves to a concrete account that
 *    is not `expectedAccount`, construction throws — naming BOTH accounts —
 *    before a single resource is created. `src/main.ts` binds `env` to the
 *    expected account/region, so the CDK CLI refuses a wrong-profile
 *    `cdk deploy` on its own ("current credentials are for account X, stack
 *    is in account Y"); this class is the second wall, for the case where a
 *    future edit passes `env` explicitly.
 * 2. **No context lookups, ever.** `availabilityZones` is answered with
 *    `Fn::GetAZs` instead of the availability-zones context provider, so an
 *    env-BOUND stack still synthesizes with no AWS credentials and no AWS API
 *    call. That is what lets the app pin `env` (and therefore inherit the
 *    CLI's account check) without giving up credential-free synth.
 *
 * A mismatched *region* is a warning rather than an error: it does not put
 * production data at risk, but the billing alarm (`AWS/Billing` publishes in
 * us-east-1 only) and the ACM edge certificate assume us-east-1.
 */
export abstract class FencedStack extends Stack {
  /** The account/region this app is fenced to. */
  public readonly fence: Fence;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const fence = resolveFence(this);
    this.fence = fence;

    if (!Token.isUnresolved(this.account) && this.account !== fence.account) {
      throw new Error(
        `Account guard: this app deploys only into AWS account ${fence.account} (${fence.region}), `
        + `but stack '${id}' resolved to account ${this.account}. `
        + 'The configured account may also host unrelated production workloads, '
        + 'which is exactly why the public playground refuses to synthesize anywhere it did not expect. '
        + `Fix the profile (AWS_PROFILE=...) or, if you really mean account ${this.account}, `
        + `re-run with -c expectedAccount=${this.account}.`,
      );
    }

    if (!Token.isUnresolved(this.region) && this.region !== fence.region) {
      Annotations.of(this).addWarning(
        `Region guard: this app expects ${fence.region} but stack '${id}' resolved to ${this.region}. `
        + 'The CloudWatch billing alarm (AWS/Billing is us-east-1 only) and the CloudFront edge certificate assume us-east-1.',
      );
    }

    // Loud, non-fatal heads-up when the shell's current credentials point
    // somewhere else: `cdk synth` still works (nothing is called), `cdk deploy`
    // will refuse.
    const cliAccount = process.env.CDK_DEFAULT_ACCOUNT;
    if (cliAccount && cliAccount !== fence.account) {
      Annotations.of(this).addWarning(
        `Current AWS credentials resolve to account ${cliAccount}, but this app targets ${fence.account}. `
        + 'Synth is unaffected (this app performs no lookups); `cdk deploy` will refuse until the profile matches.',
      );
    }
  }

  /**
   * Two AZs via `Fn::GetAZs` — deliberately NOT the availability-zones context
   * provider, which would make a live EC2 call the first time an env-bound
   * stack is synthesized. Credential-free synth is a hard requirement here.
   */
  public get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs()), Fn.select(1, Fn.getAzs())];
  }
}
