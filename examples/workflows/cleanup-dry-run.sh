#!/usr/bin/env bash
set -euo pipefail

node scripts/rnc.mjs readonly on
node scripts/rnc.mjs doctor

echo "Inspect a shallow graph map first:"
node scripts/rnc.mjs map --depth 2

echo "Search for example content:"
node scripts/rnc.mjs search "text:RemNoteConnect Examples"

echo "Dry-run a cleanup query. No writes are performed because --confirm is omitted:"
node scripts/rnc.mjs delete --query "text:RemNoteConnect Examples"

cat <<'EOF'
If the dry-run target set is exactly what you intend, execute in a deliberate write window:

  node scripts/rnc.mjs readonly off
  node scripts/rnc.mjs delete --query "text:RemNoteConnect Examples" --confirm --confirm-count <exact-count>
  node scripts/rnc.mjs readonly on

Do not copy the confirm step until you have reviewed the dry-run output.
EOF
