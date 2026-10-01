#!/usr/bin/env bash
# src/shared is the API ↔ web contract (WebSocket protocol, scenario schema/validation, templates, roles, enums).
# backend/ and frontend/ each keep their own copy so neither project depends on the other — change both together.
# This script reports drift between the two copies. It is identical in both projects.
#
# Usage: pnpm check-shared-drift [path/to/other-project]   (default: the sibling backend/ or frontend/ folder)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
sibling=frontend; [ "$(basename "$here")" = frontend ] && sibling=backend
other="${1:-$here/../$sibling}"
if [ ! -d "$other/src/shared" ]; then
  echo "skip: $other/src/shared not found (pass the other project's path to compare)"
  exit 0
fi
# Tests live only in the backend copy.
if diff -ru --exclude='*.spec.ts' "$other/src/shared" "$here/src/shared"; then
  echo "src/shared is in sync with $other"
else
  echo "src/shared differs from $other/src/shared — apply the same change to both copies." >&2
  exit 1
fi
