#!/usr/bin/env bash
# launchd entrypoint: load the same plugin environment as relay-ctl, then pin the launcher's
# Herdr socket before starting the socket-only daemon.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:?missing HERDR_PLUGIN_CONFIG_DIR}"
# Keep this parser aligned with relay-ctl.sh: configuration is dotenv data, never shell code.
load_dotenv() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
      export "$key=$value"
    else
      echo "warning: ignoring invalid line in ${file}" >&2
    fi
  done < "$file"
}
load_dotenv "${CONFIG_DIR}/.env"

export HERDR_SOCKET_PATH="${HERDR_RELAY_LAUNCH_SOCKET_PATH:?missing HERDR_RELAY_LAUNCH_SOCKET_PATH}"
exec "${HERDR_RELAY_LAUNCH_BUN:?missing HERDR_RELAY_LAUNCH_BUN}" run "${PLUGIN_ROOT}/bridge/index.ts"
