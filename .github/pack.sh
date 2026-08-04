#!/usr/bin/env bash
#
# Packs the shippable extension into $1.
#
# ALLOWLIST, deliberately. The old command was
#   zip -r extension.zip . -x ".git/*" -x ".github/*" -x "testing/*"
# which excluded neither node_modules/ nor tests/ nor package-lock.json nor
# the 60 KB developer changelog. It only ever produced a sane archive because
# CI never ran `npm ci`; the day anything installed dependencies before this
# step, every user would have been shipped ESLint and Playwright.
#
# The failure mode of an allowlist (a newly added directory is missing from
# the build) is loud and caught immediately. The failure mode of a denylist is
# silently shipping the world. Add new top-level paths here.
set -euo pipefail

OUT="${1:?usage: pack.sh <output.zip>}"

INCLUDE=(
  manifest.json
  LICENSE
  README.md
  assets
  css
  html
  images
  js
  service_worker
)

for path in "${INCLUDE[@]}"; do
  if [ ! -e "$path" ]; then
    echo "pack.sh: missing '$path' — update INCLUDE in .github/pack.sh" >&2
    exit 1
  fi
done

rm -f "$OUT"
zip -r -q "$OUT" "${INCLUDE[@]}"

# Guard rails: prove the archive is shippable rather than assuming it.
if ! unzip -l "$OUT" | grep -q "manifest.json"; then
  echo "pack.sh: manifest.json missing from $OUT" >&2
  exit 1
fi
# `unzip -l` indents every path, so anchor on whitespace-or-slash, not ^.
# B is the boundary; without it ".env" also matches "foo.environment.js".
B='(^|[[:space:]/])'
if unzip -l "$OUT" | grep -Eq "${B}node_modules/|${B}tests/|${B}package(-lock)?\.json|${B}\.env"; then
  echo "pack.sh: archive contains files that must not ship" >&2
  unzip -l "$OUT" >&2
  exit 1
fi

echo "pack.sh: wrote $OUT"
unzip -l "$OUT" | tail -n 1
