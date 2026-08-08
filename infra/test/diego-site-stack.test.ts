import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { UNCONFIGURED_ACCOUNT_ERROR } from '../src/constructs/fenced-stack';
import { applyProjectTags, PROJECT_TAGS } from '../src/constructs/project-tags';
import {
  DiegoSiteStack,
  SITE_APP_KEY,
  SITE_PIPELINE_NAME,
  SITE_RESOURCE_PREFIX,
  SITE_SSM_PREFIX,
} from '../src/diego-site-stack';

/** Managed policy ids CDK inlines for the policies this stack asks for. */
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

/**
 * The real account id is never committed (it comes from `-c expectedAccount`
 * or `CDK_EXPECTED_ACCOUNT`), so the suite fences itself to a documentation
 * account and passes it through context — which also keeps the tests hermetic
 * against whatever the developer's shell exports.
 */
const TEST_ACCOUNT = '111122223333';
const TEST_REGION = 'us-east-1';
const FENCE_CONTEXT = { expectedAccount: TEST_ACCOUNT, expectedRegion: TEST_REGION };

interface TemplateResource {
  Type: string;
  Properties?: Record<string, any>;
  Metadata?: Record<string, any>;
}

/** Physical-name properties this stack sets deliberately (F5). */
const NAME_PROPERTIES = [
  'AlarmName', 'BucketName', 'ClusterName', 'DBInstanceIdentifier', 'Family',
  'GroupName', 'LoadBalancerName', 'LogGroupName', 'Name', 'RepositoryName',
  'SecretName', 'ServiceName', 'TopicName',
];

let template: Template;
let resources: Record<string, TemplateResource>;

/** The stack exactly as `main.ts` builds it: bound to the fenced account. */
function synthSite(context: Record<string, unknown> = {}): Template {
  const app = new App({ context: { ...FENCE_CONTEXT, ...context } });
  applyProjectTags(app);
  const stack = new DiegoSiteStack(app, 'DiegoSiteStack', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
  });
  return Template.fromStack(stack);
}

/** A stack with the fence configured but no bound environment. */
function unboundSite(context: Record<string, unknown> = {}): DiegoSiteStack {
  return new DiegoSiteStack(new App({ context: { ...FENCE_CONTEXT, ...context } }), 'DiegoSiteStack');
}

function findByType(type: string, from: Record<string, TemplateResource> = resources): TemplateResource[] {
  return Object.values(from).filter((r) => r.Type === type);
}

function distributionConfig(from: Record<string, TemplateResource> = resources): Record<string, any> {
  const [distribution] = findByType('AWS::CloudFront::Distribution', from);
  expect(distribution).toBeDefined();
  return distribution.Properties!.DistributionConfig;
}

/** The `Origins[]` entry a behavior points at, resolved through TargetOriginId. */
function originFor(behavior: Record<string, any>, from?: Record<string, TemplateResource>): Record<string, any> {
  const config = distributionConfig(from);
  const origin = config.Origins.find((o: any) => o.Id === behavior.TargetOriginId);
  expect(origin).toBeDefined();
  return origin;
}

beforeAll(() => {
  template = synthSite();
  resources = template.toJSON().Resources as Record<string, TemplateResource>;
});

describe('site delivery (S3 + CloudFront is the only public entry)', () => {
  test('default behavior serves the private bucket through an Origin Access Control', () => {
    const config = distributionConfig();
    const origin = originFor(config.DefaultCacheBehavior);

    expect(origin.S3OriginConfig).toBeDefined();
    expect(origin.OriginAccessControlId).toBeDefined();
    expect(origin.DomainName).toEqual({ 'Fn::GetAtt': [expect.stringContaining('siteBucket'), 'RegionalDomainName'] });

    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', Match.objectLike({
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    }));
  });

  test('the bucket is private: public access blocked, only CloudFront may read it', () => {
    template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      BucketName: `${SITE_RESOURCE_PREFIX}web-${TEST_ACCOUNT}-${TEST_REGION}`,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }));

    template.hasResourceProperties('AWS::S3::BucketPolicy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: Match.anyValue() }),
          }),
        ]),
      }),
    }));
  });

  test('/api/* behavior forwards to the ALB origin, uncached, all methods', () => {
    const config = distributionConfig();
    const api = config.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*');
    expect(api).toBeDefined();

    expect(api.CachePolicyId).toBe(CACHING_DISABLED);
    expect(api.OriginRequestPolicyId).toBe(ALL_VIEWER_EXCEPT_HOST_HEADER);
    expect(api.AllowedMethods).toEqual(expect.arrayContaining(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']));
    expect(api.ViewerProtocolPolicy).toBe('redirect-to-https');

    // The origin is the load balancer itself (bootstrap mode: no DNS yet).
    const origin = originFor(api);
    expect(origin.CustomOriginConfig).toBeDefined();
    expect(origin.DomainName).toEqual({ 'Fn::GetAtt': [expect.stringContaining('blogAlb'), 'DNSName'] });
  });

  test('SPA routing is behavior-scoped, so API 403/404s are never rewritten', () => {
    const config = distributionConfig();
    expect(config.DefaultRootObject).toBe('index.html');
    expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [expect.stringContaining('SpaRewrite'), 'FunctionARN'] } },
    ]);
    // A distribution-wide 403/404 -> /index.html mapping would also swallow
    // the API's honest errors; there must not be one.
    expect(config.CustomErrorResponses).toBeUndefined();

    const [fn] = findByType('AWS::CloudFront::Function');
    expect(fn.Properties!.FunctionCode).toContain('/index.html');
  });
});

describe('blog service (panel key: the `blog` scope)', () => {
  test('ARM64 Fargate task, cpu 256 / memory 512', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', Match.objectLike({
      Cpu: '256',
      Memory: '512',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: Match.objectLike({
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      }),
    }));
  });

  test('service is Spot-first with a FARGATE fallback lane, desiredCount 1', () => {
    template.hasResourceProperties('AWS::ECS::Service', Match.objectLike({
      ServiceName: `${SITE_RESOURCE_PREFIX}api`,
      DesiredCount: 1,
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT' }),
        Match.objectLike({ CapacityProvider: 'FARGATE' }),
      ]),
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      }),
    }));
  });

  test('container env: EVENT_STORE=postgres, PORT 3000, DATABASE_URL, ADMIN_TOKEN from Secrets Manager', () => {
    const [taskDefinition] = findByType('AWS::ECS::TaskDefinition');
    const [container] = taskDefinition.Properties!.ContainerDefinitions;

    const env = Object.fromEntries(container.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env.EVENT_STORE).toBe('postgres');
    expect(env.PORT).toBe('3000');
    expect(JSON.stringify(env.DATABASE_URL)).toContain('{{resolve:secretsmanager:');
    expect(JSON.stringify(env.DATABASE_URL)).toContain('postgres://');

    expect(container.Secrets).toEqual([
      { Name: 'ADMIN_TOKEN', ValueFrom: expect.anything() },
    ]);
  });

  test('the LogGroup lives inside the blog scope (the panel keys off the parent id)', () => {
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    const ids = Object.keys(logGroups);
    expect(ids).toHaveLength(1);
    expect(ids[0].startsWith('blog')).toBe(true);
    expect(logGroups[ids[0]].Properties!.LogGroupName).toBe(`${SITE_RESOURCE_PREFIX}blog`);
  });

  test('ALB target group health check hits /api/posts', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', Match.objectLike({
      HealthCheckPath: '/api/posts',
      Port: 3000,
    }));
  });
});

describe('database (panel key: the `database` scope)', () => {
  test('single-AZ PostgreSQL db.t4g.micro, encrypted, 20GiB gp3, 7d backups, deletion protection', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', Match.objectLike({
      DBInstanceIdentifier: `${SITE_RESOURCE_PREFIX}db`,
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      DBInstanceClass: 'db.t4g.micro',
      MultiAZ: false,
      StorageEncrypted: true,
      AllocatedStorage: '20',
      StorageType: 'gp3',
      BackupRetentionPeriod: 7,
      DeletionProtection: true,
    }));
  });

  test('Postgres accepts 5432 from the service security group only', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', Match.objectLike({
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    }));

    const openToWorld = findByType('AWS::EC2::SecurityGroupIngress')
      .filter((r) => r.Properties!.FromPort === 5432)
      .filter((r) => r.Properties!.CidrIp !== undefined || r.Properties!.CidrIpv6 !== undefined);
    expect(openToWorld).toHaveLength(0);
  });

  test('runs in isolated subnets', () => {
    const [subnetGroup] = findByType('AWS::RDS::DBSubnetGroup');
    const refs = JSON.stringify(subnetGroup.Properties!.SubnetIds);
    expect(refs).toContain('isolated');
    expect(refs).not.toContain('public');
  });
});

describe('networking', () => {
  test('no NAT gateways (the cost floor stays the ALB)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('2 AZs, public + isolated subnets only', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    const subnets = findByType('AWS::EC2::Subnet');
    expect(subnets.filter((s) => s.Properties!.MapPublicIpOnLaunch === true)).toHaveLength(2);
  });

  test('availability zones come from Fn::GetAZs, never a context lookup', () => {
    // A lookup would mean an AWS API call at synth time; this app must
    // synthesize with no credentials even though `env` is pinned.
    const [subnet] = findByType('AWS::EC2::Subnet');
    expect(JSON.stringify(subnet.Properties!.AvailabilityZone)).toContain('Fn::GetAZs');
  });
});

describe('pipeline', () => {
  test('named eleva-diego-site-prod (the panel requires the eleva-<app>-<env> shape)', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', Match.objectLike({
      Name: SITE_PIPELINE_NAME,
    }));
  });

  test('carries Eleva::Panel metadata: category pipeline, deploys diego-site', () => {
    const [pipeline] = findByType('AWS::CodePipeline::Pipeline');
    expect(pipeline.Metadata?.['Eleva::Panel']).toMatchObject({
      category: 'pipeline',
      group: SITE_APP_KEY,
      deploys: [SITE_APP_KEY],
    });
  });

  test('builds the image, publishes the frontend and invalidates the CDN', () => {
    const [pipeline] = findByType('AWS::CodePipeline::Pipeline');
    const stages: any[] = pipeline.Properties!.Stages;
    expect(stages.map((s) => s.Name)).toEqual(['Source', 'Build', 'Deploy']);

    const actions = stages.flatMap((s) => s.Actions.map((a: any) => `${a.ActionTypeId.Provider}:${a.Name}`));
    expect(actions).toEqual(expect.arrayContaining([
      'CodeStarSourceConnection:GitHub',
      'CodeBuild:DockerBuild',
      'CodeBuild:FrontendBuild',
      'ECS:DeployToEcs',
      'CodeBuild:PublishFrontend',
      'CodeBuild:InvalidateCdn',
    ]));
  });

  test('docker build passes GIT_SHA / BUILD_TIME build args', () => {
    const buildSpecs = findByType('AWS::CodeBuild::Project')
      .map((p) => JSON.stringify(p.Properties!.Source?.BuildSpec ?? ''));
    const dockerBuild = buildSpecs.find((s) => s.includes('docker build'));
    expect(dockerBuild).toBeDefined();
    expect(dockerBuild).toContain('--build-arg GIT_SHA=');
    expect(dockerBuild).toContain('--build-arg BUILD_TIME=');
  });
});

describe('SSM parameters (/diego/prod/site/*)', () => {
  test.each([
    'siteBucket',
    'distributionId',
    'albDnsName',
    'ecrRepoUri',
    'serviceName',
    'dbInstanceId',
  ])('%s is published', (name) => {
    template.hasResourceProperties('AWS::SSM::Parameter', Match.objectLike({
      Name: `${SITE_SSM_PREFIX}/${name}`,
    }));
  });
});

describe("Metadata['Eleva::Panel']", () => {
  test('CloudFront is the public entrypoint: HTTPS 443 from Web', () => {
    const [distribution] = findByType('AWS::CloudFront::Distribution');
    expect(distribution.Metadata?.['Eleva::Panel']).toMatchObject({
      category: 'cdn',
      group: SITE_APP_KEY,
      public: { protocol: 'HTTPS', port: 443, from: 'Web' },
    });
  });

  test('the ALB is NOT advertised as a public entrypoint (CloudFront is)', () => {
    const [alb] = findByType('AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(alb.Metadata?.['Eleva::Panel']).toMatchObject({ category: 'network', group: SITE_APP_KEY });
    expect(alb.Metadata?.['Eleva::Panel'].public).toBeUndefined();
  });

  test('the schedulable resources (service, database) share the diego-site group', () => {
    const [service] = findByType('AWS::ECS::Service');
    const [db] = findByType('AWS::RDS::DBInstance');
    expect(service.Metadata?.['Eleva::Panel']).toMatchObject({ group: SITE_APP_KEY });
    expect(db.Metadata?.['Eleva::Panel']).toMatchObject({ group: SITE_APP_KEY });
  });

  test('categories are set where the panel could not infer the type', () => {
    const categories = Object.values(resources)
      .filter((r) => r.Metadata?.['Eleva::Panel']?.category)
      .map((r) => r.Metadata!['Eleva::Panel'].category);
    expect(new Set(categories)).toEqual(new Set(['cdn', 'storage', 'network', 'registry', 'logs', 'secret', 'pipeline']));
  });
});

describe('F1 — account guard', () => {
  const WRONG_ACCOUNT = '444455556666';

  test('a stack resolving to another account refuses to synthesize, naming both accounts', () => {
    let error: Error | undefined;
    try {
      new DiegoSiteStack(new App({ context: FENCE_CONTEXT }), 'DiegoSiteStack', {
        env: { account: WRONG_ACCOUNT, region: TEST_REGION },
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain(TEST_ACCOUNT);
    expect(error!.message).toContain(WRONG_ACCOUNT);
    expect(error!.message).toMatch(/production/i);
  });

  test('no configured account at all is a hard stop, not a guess', () => {
    const app = new App({ context: { expectedAccount: undefined } });
    // Belt and braces: whatever the developer's shell exports must not leak in.
    const previous = process.env.CDK_EXPECTED_ACCOUNT;
    delete process.env.CDK_EXPECTED_ACCOUNT;
    try {
      expect(() => new DiegoSiteStack(app, 'DiegoSiteStack')).toThrow(UNCONFIGURED_ACCOUNT_ERROR);
    } finally {
      if (previous !== undefined) process.env.CDK_EXPECTED_ACCOUNT = previous;
    }
  });

  test('the expected account synthesizes', () => {
    expect(() => synthSite()).not.toThrow();
  });

  test('an env-agnostic stack is allowed (no account resolved yet, no lookups performed)', () => {
    expect(() => unboundSite()).not.toThrow();
  });

  test('warns when the shell credentials point at another account (synth still works)', () => {
    const previous = process.env.CDK_DEFAULT_ACCOUNT;
    process.env.CDK_DEFAULT_ACCOUNT = WRONG_ACCOUNT;
    try {
      const stack = unboundSite();
      Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp(`account ${WRONG_ACCOUNT}`));
    } finally {
      if (previous === undefined) delete process.env.CDK_DEFAULT_ACCOUNT;
      else process.env.CDK_DEFAULT_ACCOUNT = previous;
    }
  });

  test('-c expectedAccount deliberately retargets the app', () => {
    const app = new App({ context: { expectedAccount: WRONG_ACCOUNT } });
    expect(() => new DiegoSiteStack(app, 'DiegoSiteStack', {
      env: { account: WRONG_ACCOUNT, region: TEST_REGION },
    })).not.toThrow();
  });
});

describe('F4 — dedicated network', () => {
  test('importing a VPC is refused: the playground never shares production networking', () => {
    let error: Error | undefined;
    try {
      unboundSite({ vpcId: 'vpc-0abc123def4567890' });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('vpc-0abc123def4567890');
    expect(error!.message).toMatch(/production/i);
  });

  test('the stack always creates its own VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });
});

describe('F5 — name prefixes', () => {
  function physicalNames(): Array<{ type: string; property: string; value: string }> {
    const found: Array<{ type: string; property: string; value: string }> = [];
    for (const resource of Object.values(resources)) {
      for (const property of NAME_PROPERTIES) {
        const value = resource.Properties?.[property];
        if (typeof value === 'string') found.push({ type: resource.Type, property, value });
      }
    }
    return found;
  }

  test('every physically-named resource is prefixed diego-site- (SSM paths and the pipeline aside)', () => {
    // Glue databases/tables forbid hyphens, so there — and only there — the
    // prefix wears underscores. Same fence, different spelling.
    const underscorePrefix = SITE_RESOURCE_PREFIX.replace(/-/g, '_');
    const offenders = physicalNames().filter(({ value }) =>
      !value.startsWith(SITE_RESOURCE_PREFIX)
      && !value.startsWith(underscorePrefix)
      && !value.startsWith(`${SITE_SSM_PREFIX}/`)
      && value !== SITE_PIPELINE_NAME);
    expect(offenders).toEqual([]);
  });

  test('nothing is named eleva-* except the panel-mandated pipeline', () => {
    const elevaNames = physicalNames().filter(({ value }) => value.startsWith('eleva-'));
    expect(elevaNames.map((n) => n.value)).toEqual([SITE_PIPELINE_NAME]);
  });

  test('the stack id is DiegoSiteStack', () => {
    const stack = unboundSite();
    expect(Stack.of(stack).stackName).toBe('DiegoSiteStack');
  });
});

describe('F6 — tagging', () => {
  test('project / owner / exposure land on the stack resources', () => {
    const [bucket] = findByType('AWS::S3::Bucket');
    const tags = Object.fromEntries((bucket.Properties!.Tags as any[]).map((t) => [t.Key, t.Value]));
    expect(tags).toMatchObject(PROJECT_TAGS);
  });

  test('exposure is explicitly public-demo', () => {
    expect(PROJECT_TAGS.exposure).toBe('public-demo');
  });
});

describe('F7 — budget guard is owned by exactly one stack', () => {
  test('the site stack declares no budget (BudgetName is account-global; DiegoControlStack owns it)', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  test('but it supplies the cost-allocation tag the budget filters on', () => {
    const [service] = findByType('AWS::ECS::Service');
    const tags = Object.fromEntries((service.Properties!.Tags as any[]).map((t) => [t.Key, t.Value]));
    expect(tags.project).toBe(PROJECT_TAGS.project);
  });
});

describe('region hygiene', () => {
  test('a stack pinned away from the fenced region says so', () => {
    const stack = new DiegoSiteStack(new App({ context: FENCE_CONTEXT }), 'DiegoSiteStack', {
      env: { account: TEST_ACCOUNT, region: 'eu-west-1' },
    });
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('Region guard'));
  });
});

describe('ALB ingress', () => {
  test('by default the origin accepts the internet (CloudFront has no fixed IPs)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', Match.objectLike({
      GroupName: `${SITE_RESOURCE_PREFIX}alb`,
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 80 }),
      ]),
    }));
  });

  test('-c cloudfrontPrefixListId locks the origin to the CloudFront edge, with nothing left open', () => {
    const locked = synthSite({ cloudfrontPrefixListId: 'pl-3b927c52' });

    locked.hasResourceProperties('AWS::EC2::SecurityGroupIngress', Match.objectLike({
      SourcePrefixListId: 'pl-3b927c52',
      FromPort: 80,
      ToPort: 80,
    }));

    // The listener's default `open: true` would have re-added 0.0.0.0/0 and
    // silently undone the prefix list.
    const albSecurityGroup = Object.values(locked.toJSON().Resources as Record<string, TemplateResource>)
      .find((r) => r.Type === 'AWS::EC2::SecurityGroup' && r.Properties?.GroupName === `${SITE_RESOURCE_PREFIX}alb`);
    expect(albSecurityGroup!.Properties!.SecurityGroupIngress).toBeUndefined();
  });
});

describe('with domainName + hostedZoneId (DNS/TLS enabled)', () => {
  let dns: Template;
  let dnsResources: Record<string, TemplateResource>;

  beforeAll(() => {
    dns = synthSite({ hostedZoneId: 'Z0123456789ABCDEFGHIJ' });
    dnsResources = dns.toJSON().Resources as Record<string, TemplateResource>;
  });

  test('CloudFront serves the apex and www under an ACM certificate', () => {
    const config = distributionConfig(dnsResources);
    expect(config.Aliases).toEqual(['diegopalominos.dev', 'www.diegopalominos.dev']);
    expect(config.ViewerCertificate.SslSupportMethod).toBe('sni-only');
  });

  test('A + AAAA aliases for apex, www and the ALB origin host', () => {
    const records = findByType('AWS::Route53::RecordSet', dnsResources)
      .map((r) => `${r.Properties!.Name}${r.Properties!.Type}`);
    expect(records.sort()).toEqual([
      'diegopalominos.dev.A',
      'diegopalominos.dev.AAAA',
      'origin.diegopalominos.dev.A',
      'origin.diegopalominos.dev.AAAA',
      'www.diegopalominos.dev.A',
      'www.diegopalominos.dev.AAAA',
    ]);
  });

  test('the /api/* origin is the ALB behind its own hostname, over HTTPS', () => {
    const config = distributionConfig(dnsResources);
    const api = config.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*');
    const origin = config.Origins.find((o: any) => o.Id === api.TargetOriginId);
    expect(origin.DomainName).toBe('origin.diegopalominos.dev');
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');

    dns.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.anyValue(),
    }));
  });

  test('-c cloudfrontCertificateArn skips the us-east-1 certificate custom resource', () => {
    const imported = synthSite({
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      cloudfrontCertificateArn: `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/abc`,
    });
    imported.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    // Only the regional ALB origin certificate remains.
    imported.resourceCountIs('AWS::CertificateManager::Certificate', 1);
  });
});
