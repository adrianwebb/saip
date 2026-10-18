#!/usr/bin/env bash
# Link checker for SAIP documentation site
# Validates all internal links in the built output resolve to existing pages.
# Handles absolute (/saip/...) and relative (./, ../) hrefs using browser URL semantics:
# a page at /a/b/c/ treats "../d/" as "/a/d/", NOT "/a/b/d/".
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

# Resolve href against page URL dir using browser semantics.
# page_dir MUST end with '/' (e.g. /saip/tutorials/getting-started/)
resolve_href() {
  local page_dir="$1"
  local href="$2"

  if [[ "$href" == /* ]]; then
    printf '%s' "$href"
  else
    # Strip leading ./ or ../ sequences correctly per browser rules:
    # each "../" pops one trailing path segment from page_dir
    local work="$page_dir"
    local rest="$href"
    while [[ "$rest" == "../"* ]]; do
      rest="${rest#../}"
      # pop last segment of work
      work=$(printf '%s' "${work%/}" | sed 's|/[^/]*$||')
      work="${work}/"
    done
    # strip any remaining "./" prefixes
    while [[ "$rest" == "./"* ]]; do
      rest="${rest#./}"
    done
    printf '%s%s' "$work" "$rest"
  fi
}

for HTML_FILE in $(find "$DIST_DIR" -name "index.html" | sort); do
  REL_PAGE=$(echo "$HTML_FILE" | sed "s|^${DIST_DIR}/||;s|/index.html$||")
  PAGE_URL_DIR="${BASE}/${REL_PAGE}/"

  HREFS=$(grep -oP 'href="[^"]*"' "$HTML_FILE" \
    | sed 's/href="//;s/"$//' \
    | grep -E '^(/|\.\.?/)' \
    | grep -v '\.\(css\|js\|svg\|png\|jpg\|jpeg\|gif\|xml\|json\|woff2?\|ico\)$' \
    | grep -v '#' \
    | grep -v '^https\?://' \
    | sort -u || true)

  for HREF in $HREFS; do
    CHECKED=$((CHECKED + 1))
    RESOLVED=$(resolve_href "$PAGE_URL_DIR" "$HREF")
    FS_PATH="${DIST_DIR}${RESOLVED#${BASE}}"

    if [ -f "${FS_PATH}/index.html" ] || [ -f "${FS_PATH}" ]; then
      : # OK
    else
      BROKEN=$((BROKEN + 1))
      echo "❌ ${PAGE_URL_DIR} → ${HREF}  (resolved: ${RESOLVED})"
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
