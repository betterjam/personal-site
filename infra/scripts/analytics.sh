#!/usr/bin/env bash
# Visitor metrics from the terminal — runs the stack's saved Athena queries
# against the CloudFront access logs and prints the results.
#
#   AWS_PROFILE=eleva ./scripts/analytics.sh            # the daily reports
#   AWS_PROFILE=eleva ./scripts/analytics.sh recurrent  # who comes back
#   AWS_PROFILE=eleva ./scripts/analytics.sh cities     # where visitors are
#
# Reports: visitors | pages | referrers | regions | recurrent | cities | all
#
# `cities` geolocates visitor IPs through ip-api.com (free, batch, no key).
# That sends the IPs to a third-party service — it runs only when you ask
# for it, and city-level IP geolocation is approximate by nature.
# (Logs land in S3 with up to ~an hour of delay; history accrues from the
# day logging was enabled, and the bucket keeps 365 days of it.)
set -euo pipefail

WG=diego-site-analytics
DB=diego_site_analytics
REGION=${AWS_REGION:-us-east-1}

# Run the saved query named diego-site-$1 and emit its results as TSV.
fetch_tsv() {
  local name=$1 qid sql exec state
  qid=$(aws athena list-named-queries --work-group "$WG" --region "$REGION" \
    --query NamedQueryIds --output text | tr '\t' '\n' | while read -r id; do
      aws athena get-named-query --named-query-id "$id" --region "$REGION" \
        --query 'NamedQuery.[NamedQueryId,Name]' --output text
    done | awk -v n="diego-site-$name" '$2==n && !found {print $1; found=1}')
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
  aws athena get-query-results --query-execution-id "$exec" --region "$REGION" --output json \
    | python3 -c '
import json, sys
for r in json.load(sys.stdin)["ResultSet"]["Rows"]:
    print("\t".join(c.get("VarCharValue", "") for c in r["Data"]))
'
}

print_table() { # stdin: TSV with header row
  python3 -c '
import sys
rows = [line.rstrip("\n").split("\t") for line in sys.stdin if line.strip()]
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

run_report() {
  echo
  echo "── $1 ──────────────────────────────────────"
  fetch_tsv "$1" | print_table
}

cities_report() {
  echo
  echo "── cities (IP geolocation via ip-api.com, approximate) ──"
  fetch_tsv visitor-ips | python3 -c '
import json, sys, time, urllib.request
rows = [line.rstrip("\n").split("\t") for line in sys.stdin if line.strip()][1:]
if not rows:
    print("(no data yet — logs arrive with ~an hour of delay)")
    sys.exit()
weight = {ip: (int(req), int(days)) for ip, req, days in rows}
ips = list(weight)
cities = {}
for i in range(0, len(ips), 100):  # ip-api batch limit: 100/request, 15 req/min
    batch = json.dumps([{"query": ip, "fields": "query,status,country,regionName,city"} for ip in ips[i:i + 100]]).encode()
    with urllib.request.urlopen(urllib.request.Request(
            "http://ip-api.com/batch", data=batch, headers={"Content-Type": "application/json"})) as resp:
        for hit in json.load(resp):
            if hit.get("status") != "success":
                continue
            key = (hit.get("city") or "?", hit.get("regionName") or "", hit.get("country") or "?")
            v, r = cities.get(key, (0, 0))
            cities[key] = (v + 1, r + weight[hit["query"]][0])
    if i + 100 < len(ips):
        time.sleep(4.5)
out = [("city", "region", "country", "visitors", "requests")]
for (city, region, country), (v, r) in sorted(cities.items(), key=lambda kv: -kv[1][0]):
    out.append((city, region, country, str(v), str(r)))
widths = [max(len(row[i]) for row in out) for i in range(5)]
for i, row in enumerate(out):
    print("  ".join(c.ljust(w) for c, w in zip(row, widths)))
    if i == 0:
        print("  ".join("-" * w for w in widths))
'
}

case "${1:-all}" in
  all) for r in audience-summary visitors-per-day top-pages referrers visitor-regions; do run_report "$r"; done ;;
  visitors) run_report visitors-per-day ;;
  pages) run_report top-pages ;;
  referrers) run_report referrers ;;
  regions) run_report visitor-regions ;;
  recurrent) run_report audience-summary; run_report returning-visitors ;;
  cities) cities_report ;;
  *) echo "usage: $0 [all|visitors|pages|referrers|regions|recurrent|cities]" >&2; exit 2 ;;
esac
