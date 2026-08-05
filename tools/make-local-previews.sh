#!/usr/bin/env bash
# Wraps the fragment mockups into standalone HTML documents for local browser viewing.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p mockups/local
count=0
for f in mockups/*.html; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  {
    printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n'
    cat "$f"
    printf '\n</body>\n</html>\n'
  } > "mockups/local/$name"
  count=$((count + 1))
done
echo "Wrote $count local previews to mockups/local/"
