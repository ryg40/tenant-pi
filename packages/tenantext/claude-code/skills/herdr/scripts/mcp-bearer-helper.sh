#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "error: usage: mcp-bearer-helper.sh VAR_NAME" >&2
  exit 2
fi

value="${!1-}"
if [ -z "$value" ]; then
  echo "error: required environment variable is unset or empty" >&2
  exit 1
fi

VALUE="$value" python3 -c 'import json, os; print(json.dumps({"Authorization": "Bearer " + os.environ["VALUE"]}))'
