#!/bin/bash
# DON'T use set -e — grep returns 1 on no-match which is OK here
ERRORS=0
echo "=== TS error pattern smoke test ==="

# 1 — auto-compaction reassigns messages/newMessages; ensure they're declared `let`, not `const`.
# (Reassignment itself is now intended — the bug we guard against is reassigning a const.)
if grep -qE "^\s+const newMessages: Message\[\] = \[\]" src/agent/loop.ts 2>/dev/null; then
  echo "FAIL: newMessages is declared const but auto-compaction reassigns it — must be let"
  ERRORS=$((ERRORS+1))
fi

# 2
M=$(grep -rn "\.completeStream(" src/ 2>/dev/null || true)
if [ -n "$M" ]; then
  echo "$M"
  echo "FAIL: .completeStream() called"
  ERRORS=$((ERRORS+1))
fi

# 3 — optional-dep dynamic imports must have @ts-ignore on the previous line
for pkg in "'pg'" "'mysql2/promise'" "'better-sqlite3'" "'gpt-tokenizer'"; do
  while IFS=: read -r file line content; do
    [ -z "$file" ] && continue
    prev=$((line - 1))
    prevline=$(sed -n "${prev}p" "$file")
    if [[ "$prevline" != *"@ts-ignore"* ]]; then
      echo "FAIL: $file:$line — $pkg import without @ts-ignore on previous line"
      ERRORS=$((ERRORS+1))
    fi
  done < <(grep -rn "await import(${pkg})" src/ 2>/dev/null || true)
done

# 4
if ! grep -q "^export type { Message" src/llm/types.ts; then
  echo "FAIL: Message not re-exported from src/llm/types.ts"
  ERRORS=$((ERRORS+1))
fi

# 5
M=$(grep -rnE "tool_calls\.map\(tc =>" src/ 2>/dev/null || true)
if [ -n "$M" ]; then
  echo "$M"
  echo "FAIL: implicit-any in tool_calls.map(tc => ...)"
  ERRORS=$((ERRORS+1))
fi

# 6 — Diagnostic objects use `col?`, never `column`. A `column:` key in any
# Diagnostic literal is a TS2353 that a full `tsc` build rejects (and that the
# grep-only check used to miss). Guard the exact field name in the parsers file.
M=$(grep -rnE "^\s*column:" src/tools/diagnostics/ 2>/dev/null || true)
if [ -n "$M" ]; then
  echo "$M"
  echo "FAIL: Diagnostic literal uses 'column:' — the interface field is 'col?'. Rename to col."
  ERRORS=$((ERRORS+1))
fi

if [ "$ERRORS" -eq 0 ]; then
  echo "OK: smoke tests pass"
else
  echo "FAIL: $ERRORS issue(s) found"
  exit 1
fi
