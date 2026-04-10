#!/bin/bash
cd /root/beer-pos/public/js

echo "=== Checking all JS files for conflict markers ==="
for f in *.js; do
  markers=$(grep -c '<<<<<<<' "$f" 2>/dev/null || echo 0)
  if [ "$markers" -gt 0 ]; then
    echo "CONFLICT in $f ($markers markers)"
    # Show context
    grep -n '<<<<<<<' "$f" | head -3
    echo "---"
  fi
done

echo ""
echo "=== Removing conflict markers from realtime.js ==="
# Find the line range to remove (from <<<<<<< to >>>>>>>)
start_line=$(grep -n '<<<<<<<' realtime.js | head -1 | cut -d: -f1)
end_line=$(grep -n '>>>>>>>' realtime.js | tail -1 | cut -d: -f1)

echo "Start: $start_line, End: $end_line"

if [ -n "$start_line" ] && [ -n "$end_line" ]; then
  # Remove from start_line to end_line inclusive, plus the line before (======= boundary)
  sed -i "${start_line},${end_line}d" realtime.js
  # Also remove the '=======' line (it would be just before what we deleted, but let's find it)
  echo "Deleted lines $start_line to $end_line"

  # Verify
  remaining=$(grep -c '<<<<<<<' realtime.js 2>/dev/null || echo 0)
  echo "Remaining <<<<<<< markers: $remaining"
fi

echo ""
echo "=== Checking other JS files ==="
for f in *.js; do
  markers=$(grep -c '<<<<<<<' "$f" 2>/dev/null || echo 0)
  if [ "$markers" -gt 0 ]; then
    echo "STILL CONFLICTED: $f"
  fi
done

echo ""
echo "=== Verifying realtime.js syntax ==="
node --check realtime.js 2>&1 && echo "SYNTAX OK" || echo "SYNTAX ERROR"

echo ""
echo "=== Done ==="