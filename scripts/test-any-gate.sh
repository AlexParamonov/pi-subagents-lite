#!/usr/bin/env bash
# Detects explicit TypeScript `any` annotations in test files.
# Exit 0 = clean, exit 1 = regressions found.
#
# Allowlisted (blanked before scanning):
#   - expect.any(...) vitest matchers
#   - fakeCtx function signature + return type (test/fixtures.ts)
#   - createMockCtx function signature + return type (test/menu-test-helpers.ts)
#   - Comment-only lines (// ... or * ...) — documentation, not types

set -euo pipefail

# Step 1: Create a temp copy with allowlisted regions blanked out.
# This handles multi-line signatures (e.g., createMockCtx spans two lines).
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cp -r test/* "$TMP/"

# Blank allowlisted lines:
#   - expect.any( lines → vitest matchers, not TS `any`
#   - fakeCtx and createMockCtx function signatures (multi-line via address ranges)
#   - Comment lines (// or *) — documentation, not type annotations
find "$TMP" -name '*.ts' -exec sed -i \
  -e '/expect\.any(/d' \
  -e '/^export function fakeCtx(): any/d' \
  -e '/^export function createMockCtx/,/^): any/d' \
  -e '/^[[:space:]]*\/\//d' \
  -e '/^[[:space:]]*\*/d' \
  {} +

# Step 2: Scan the blanked copy for any remaining 'any' patterns.
# \bany\b ensures whole-word match (avoids "anyOf", "manyLines", etc.)
HITS=$(grep -rn --include='*.ts' -E ': \bany\b|as \bany\b|<\bany\b|\bany\b>|\bany\b\[\]' "$TMP" || true)

if [ -n "$HITS" ]; then
  # Strip the temp path prefix to show original file paths.
  RELATIVE=$(echo "$HITS" | sed "s|$TMP/||")
  echo "ERROR: explicit 'any' found in test code:" >&2
  echo "$RELATIVE" >&2
  exit 1
fi

echo "OK: no explicit any found"
