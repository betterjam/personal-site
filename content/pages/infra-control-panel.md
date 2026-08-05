---
summary: A one-page ops console that draws the platform's architecture live from the deployed CloudFormation template. Power buttons included.
repo: betterjam/eleva-aws-infra-control
image: asset:eleva-control-app/live-architecture-diagram
gallery: asset:eleva-control-app/service-power-and-scheduling-dashboard|Power buttons and schedule rules, asset:eleva-control-app/weekly-availability-heatmap|Weekly availability, derived from the schedules, asset:eleva-control-app/configuration-drift-check|Drift — code versus deployed reality, asset:eleva-control-app/cicd-pipelines-and-notifications|Pipelines, approvals and notifications
---
# Infra Control Panel

Hand-drawn architecture diagrams start lying the week after they're drawn. So this panel doesn't draw — it **reads**: the diagram renders live from the deployed CloudFormation template, tier by tier, with animated request flows. If it's on the screen, it's actually deployed.

## What it does

- **Power** — ECS services and RDS instances get on/off buttons and schedule rules ("all services off, 21:00 weekdays"). The lights-out factory, operated from a browser.
- **Pipelines** — run, watch, approve gates, subscribe to failures.
- **Drift** — code versus reality, per resource, before reality wins.
- **Logs** — search and live-tail any allow-listed group without opening the AWS console.

## The conventions trick

The panel never needs updating for new stacks. Any CDK stack that follows the naming conventions — services in their own construct scopes, log groups inside them, pipelines prefixed correctly — appears automatically with power buttons and schedules. Conventions beat configuration, every time. [This site's own stack](#/page/this-site) is the latest proof.

## What it taught me

An ops tool people *enjoy* opening changes how a platform gets operated. Nobody enjoys opening a runbook.
