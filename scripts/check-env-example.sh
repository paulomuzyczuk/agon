#!/usr/bin/env sh
# Fails if .env.example has `KEY=   # comment`. Docker Compose's env_file parser
# passes the comment text through as the value when the value is empty, which
# silently breaks every "empty = use the default" setting (MZY-396). Keep comments
# on their own line above the variable. Takes an optional file path for the test.
file="${1:-.env.example}"
if grep -nE '^[A-Za-z0-9_]+=[[:space:]]+#' "$file"; then
  echo "error: inline comment after an empty value in $file (see above)." >&2
  echo "Move the comment to its own line above the variable." >&2
  exit 1
fi
