#!/usr/bin/env bash
# launchd entrypoint: load the same plugin environment as collie-ctl, then pin the launcher's
# validated socket/port/public-host values before starting the long-lived bridge process.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:?missing HERDR_PLUGIN_CONFIG_DIR}"
# Keep this parser aligned with collie-ctl.sh: configuration is dotenv data, never shell code.
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

export HERDR_SOCKET_PATH="${HERDR_CONTROL_SOCKET_PATH:?missing HERDR_CONTROL_SOCKET_PATH}"
export COLLIE_PORT="${HERDR_CONTROL_EFFECTIVE_PORT:?missing HERDR_CONTROL_EFFECTIVE_PORT}"
export COLLIE_PUBLIC_HOSTS="${HERDR_CONTROL_PUBLIC_HOSTS:-}"
export HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS="$COLLIE_PUBLIC_HOSTS"
exec "${HERDR_CONTROL_BUN:?missing HERDR_CONTROL_BUN}" run "${PLUGIN_ROOT}/bridge/index.ts"
