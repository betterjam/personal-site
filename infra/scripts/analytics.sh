#!/usr/bin/env bash
# Visitor metrics from the terminal — runs the stack's saved Athena queries
# against the CloudFront access logs and prints the results.
#
#   AWS_PROFILE=eleva ./scripts/analytics.sh            # everything
#   AWS_PROFILE=eleva ./scripts/analytics.sh visitors   # one report
#
# Reports: visitors | pages | referrers | regions
# (Logs land in S3 with up to ~an hour of delay; history accrues from the
# day logging was enabled, and the bucket keeps 365 days of it.)
set -euo pipefail

WG=diego-site-analytics
DB=diego_site_analytics
REGION=${AWS_REGION:-us-east-1}

run_report() {
  local name=$1 qid sql exec state
  qid=$(aws athena list-named-queries --work-group "$WG" --region "$REGION" \
    --query NamedQueryIds --output text | tr '\t' '\n' | while read -r id; do
      aws athena get-named-query --named-query-id "$id" --region "$REGION" \
        --query 'NamedQuery.[NamedQueryId,Name]' --output text
    done | awk -v n="diego-site-$name" '$2==n{print $1; exit}')
  if [ -z "$qid" ]; then
    echo "no saved query named diego-site-$name (deployed the stack?)" >&2
    return 1
  fi
  sql=$(aws athena get-named-query --named-query-id "$qid" --region "$REGION" \
    --query NamedQuery.QueryString --output text)
  exec=$(aws athena start-query-execution --work-group "$WG" --region "$REGION" \
    --query-execution-context "Database=$DB" --query-string "$sql" \
    --query QueryExecutionId --output text)
  while :; do
    state=$(aws athena get-query-execution --query-execution-id "$exec" --region "$REGION" \
      --query QueryExecution.Status.State --output text)
    case "$state" in
      SUCCEEDED) break ;;
      FAILED|CANCELLED)
        aws athena get-query-execution --query-execution-id "$exec" --region "$REGION" \
          --query QueryExecution.Status.StateChangeReason --output text >&2
        return 1 ;;
      *) sleep 2 ;;
    esac
  done
  echo
  echo "── $name ──────────────────────────────────────"
  aws athena get-query-results --query-execution-id "$exec" --region "$REGION" --output json \
    | python3 -c '
import json, sys
rows = [[c.get("VarCharValue", "") for c in r["Data"]] for r in json.load(sys.stdin)["ResultSet"]["Rows"]]
if len(rows) < 2:
    print("(no data yet — logs arrive with ~an hour of delay)")
else:
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for i, r in enumerate(rows):
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
        if i == 0:
            print("  ".join("-" * w for w in widths))
'
}

case "${1:-all}" in
  all) for r in visitors-per-day top-pages referrers visitor-regions; do run_report "$r"; done ;;
  visitors) run_report visitors-per-day ;;
  pages) run_report top-pages ;;
  referrers) run_report referrers ;;
  regions) run_report visitor-regions ;;
  *) echo "usage: $0 [all|visitors|pages|referrers|regions]" >&2; exit 2 ;;
esac
