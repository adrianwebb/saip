#!/usr/bin/env bash
# Link checker for SAIP documentation site
# Validates all internal links in the built output resolve to existing pages.
# Usage: ./scripts/check-links.sh [dist-dir]

set -euo pipefail

DIST_DIR="${1:-dist}"
BASE="/saip"
BROKEN=0
CHECKED=0

if [ ! -d "$DIST_DIR" ]; then
  echo "❌ Build directory not found: $DIST_DIR"
  echo "   Run 'pnpm build' first."
  exit 1
fi

echo "Checking internal links in $DIST_DIR (base: $BASE)..."

for HTML_FILE in $(find "$DIST_DIR" -name "index.html" | sort); do
  PAGE_PATH=$(echo "$HTML_FILE" | sed "s|^${DIST_DIR}||;s|/index.html||")

  # Extract href values pointing to /saip/ paths (skip external, anchors, assets)
  HREFS=$(grep -oP "href=\"${BASE}/[^\"#]*\"" "$HTML_FILE" \
    | sed "s/href=\"//;s/\"$//" \
    | grep -v '\.\(css\|js\|svg\|png\|jpg\|xml\)$' \
    | sort -u || true)

  for HREF in $HREFS; do
    CHECKED=$((CHECKED + 1))
    FS_PATH="${DIST_DIR}${HREF#${BASE}}"

    if [ -f "${FS_PATH}/index.html" ] || [ -f "${FS_PATH}" ]; then
      : # OK
    else
      BROKEN=$((BROKEN + 1))
      echo "❌ ${PAGE_PATH:-/} → ${HREF}"
    fi
  done
done

echo ""
echo "Checked $CHECKED internal links across $(find "$DIST_DIR" -name "index.html" | wc -l) pages."

if [ "$BROKEN" -gt 0 ]; then
  echo "❌ $BROKEN broken link(s) found."
  exit 1
else
  echo "✅ All internal links valid."
fi
