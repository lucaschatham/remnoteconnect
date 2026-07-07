#!/usr/bin/env bash
set -euo pipefail

node scripts/rnc.mjs readonly on
node scripts/rnc.mjs doctor
node scripts/rnc.mjs status

echo "This example writes to RemNote under: RemNoteConnect Examples"
echo "Set RNC_CONFIRM_EXAMPLE_WRITE=yes to execute the write step."

if [ "${RNC_CONFIRM_EXAMPLE_WRITE:-}" != "yes" ]; then
  echo "Dry stop: no write performed."
  echo "To run: RNC_CONFIRM_EXAMPLE_WRITE=yes examples/workflows/create-study-guide.sh"
  exit 0
fi

node scripts/rnc.mjs readonly off
node scripts/rnc.mjs create-document \
  --md examples/documents/study-guide.md \
  --parent "RemNoteConnect Examples" \
  --confirm
node scripts/rnc.mjs readonly on
