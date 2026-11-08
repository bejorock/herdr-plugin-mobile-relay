#!/usr/bin/env bash
# Control script for Herdr Mobile Relay. Invoked by the plugin's actions and usable directly.
# The bridge runs as a systemd user service on Linux or a launchd user agent on macOS (NOT a Herdr
# plugin pane — see ARCHITECTURE.md §3), so it survives Herdr restarts and is supervised independently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="rad-herdr-mobile-relay"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"
LAUNCHD_LABEL="dev.rad.herdr-mobile-relay"
LAUNCHD_FILE="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
PLUGIN_ID="rad.herdr-mobile-relay"

# Resolve the plugin config dir (where .env lives) the SAME way no matter how we're launched.
# Herdr injects HERDR_PLUGIN_CONFIG_DIR when it runs our actions, but a direct `relay-ctl.sh` call
# doesn't get it — so we ask Herdr for the canonical path (`herdr plugin config-dir`, plain text).
# Without this, the two entry points read DIFFERENT .env files (Herdr's dir vs a ~/.config/rad-herdr-mobile-relay
# fallback). Both direct and plugin invocations must use the same configuration.
# Order: injected env → Herdr CLI → Herdr's conventional path (if it has a .env) → ~/.config/rad-herdr-mobile-relay.
resolve_config_dir() {
  if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then echo "$HERDR_PLUGIN_CONFIG_DIR"; return; fi
  if command -v herdr >/dev/null; then
    local d; d="$(herdr plugin config-dir "$PLUGIN_ID" 2>/dev/null || true)"
    if [ -n "$d" ]; then echo "$d"; return; fi
  fi
  local conventional="${HOME}/.config/herdr/plugins/config/${PLUGIN_ID}"
  if [ -f "${conventional}/.env" ]; then echo "$conventional"; return; fi
  echo "${HOME}/.config/rad-herdr-mobile-relay"
}
CONFIG_DIR="$(resolve_config_dir)"

# This directory holds relay configuration and access policy. Do not inherit
# a permissive umask (0755 dir / 0644 .env) on shared hosts.
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [ -f "${CONFIG_DIR}/.env" ]; then chmod 600 "${CONFIG_DIR}/.env"; fi

# First launch establishes one durable state directory; later direct/plugin invocations reuse it so
# conversation bindings and hook sockets cannot jump between injected and standalone defaults.
STATE_DIR_FILE="${CONFIG_DIR}/state-dir"
if [ -f "$STATE_DIR_FILE" ]; then
  IFS= read -r PLUGIN_STATE_DIR < "$STATE_DIR_FILE" || PLUGIN_STATE_DIR=""
else
  PLUGIN_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-${CONFIG_DIR}/state}"
  printf '%s\n' "$PLUGIN_STATE_DIR" > "$STATE_DIR_FILE"
  chmod 600 "$STATE_DIR_FILE"
fi
[ -n "$PLUGIN_STATE_DIR" ] || PLUGIN_STATE_DIR="${CONFIG_DIR}/state"
export HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE_DIR"

# Source the plugin .env so both this script and the systemd unit share one config source. It is
# deliberately a dotenv file, not arbitrary shell code: accepting only KEY=VALUE lines prevents a
# configuration typo or copied shell fragment from running commands when a Herdr action starts.
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
      # Match systemd EnvironmentFile's simple quote convention for common values; reject anything
      # that would need shell evaluation rather than silently interpreting it as program text.
      if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
      export "$key=$value"
    else
      echo "warning: ignoring invalid line in ${file}" >&2
    fi
  done < "$file"
}
load_dotenv "${CONFIG_DIR}/.env"

SOCKET="${HERDR_SOCKET_PATH:-${HOME}/.config/herdr/herdr.sock}"
RELAY_SOCKET="${HERDR_RELAY_SOCKET:-${PLUGIN_STATE_DIR}/relay.sock}"
export HERDR_RELAY_SOCKET="$RELAY_SOCKET"
# Herdr plugin actions can run with a minimal PATH that omits Bun's standard user install
# directory. Prefer PATH but fall back to Bun's documented per-user location.
BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x "${HOME}/.bun/bin/bun" ]; then BUN="${HOME}/.bun/bin/bun"; fi
# `bun run` scripts may invoke `bunx` or `bun` by name. Keep the discovered executable's
# directory on PATH for those child shells too, including minimal Herdr plugin action environments.
if [ -n "$BUN" ]; then export PATH="$(dirname "$BUN"):${PATH}"; fi
have_systemd() { command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }
have_launchd() { [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null; }
launchd_domain() { printf 'gui/%s' "$(id -u)"; }

pid_is_bridge() {
  local pid="${1:-}" command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"${PLUGIN_ROOT}/bridge/index.ts"* ]]
}

stop_bridge_pid() {
  local pid="${1:-}" i
  pid_is_bridge "$pid" || return 0
  kill "$pid" 2>/dev/null || return 1
  for i in $(seq 1 50); do
    pid_is_bridge "$pid" || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    pid_is_bridge "$pid" || return 0
    sleep 0.1
  done
  return 1
}

systemd_escape_value() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\%/%%}"
  value="${value//\$/\$\$}"
  printf '%s' "$value"
}

plist_escape_value() {
  printf '%s' "${1:-}" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

# Install root dependencies and typecheck. This is the whole build: the relay is a terminal/HTTP
# bridge with no frontend bundle, so there is no separate web build step. Safe to call repeatedly.
cmd_build() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  # Version gate: refuse to build a release whose version files / CHANGELOG disagree.
  # Override (e.g. mid-refactor) with SKIP_VERSION_CHECK=1.
  if [ "${SKIP_VERSION_CHECK:-}" != "1" ]; then
    bash "${PLUGIN_ROOT}/scripts/check-version.sh"
  fi
  # Install dependencies before typechecking. The root typecheck (tsconfig `types: ["bun"]`)
  # resolves @types/bun from the ROOT node_modules; a fresh Herdr checkout ships no tree, so
  # without a root install the very first build dies with TS2688 "Cannot find type definition file
  # for 'bun'" and Herdr rolls the install back (issue #9). It works on the dev host only because a
  # manual `bun install` left root node_modules behind.
  ( cd "${PLUGIN_ROOT}" && "$BUN" install )
  # Typecheck before reporting success. Skip with SKIP_TYPECHECK=1 (same hatch as the pre-push hook).
  if [ "${SKIP_TYPECHECK:-}" != "1" ]; then
    ( cd "${PLUGIN_ROOT}" && "$BUN" run typecheck )
  fi
}

relay_version() { awk -F'"' '/^version = / {print $2; exit}' "${PLUGIN_ROOT}/herdr-plugin.toml"; }
bridge_ready() {
  [ -n "$BUN" ] || return 1
  local i
  for i in $(seq 1 30); do
    if "$BUN" -e 'const response = await fetch("http://localhost/api/config", {unix: process.argv[1], signal: AbortSignal.timeout(1000)}); if (!response.ok) process.exit(1);' "$RELAY_SOCKET" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}
print_status_banner() {
  printf 'Herdr Relay %s\n  HTTP socket: %s\n  Herdr socket: %s\n' "$(relay_version)" "$RELAY_SOCKET" "$SOCKET"
  if bridge_ready; then echo "  ready: yes (owner socket; connect through SSH)"; else echo "  ready: no"; fi
}

write_launchd_agent() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$LAUNCHD_FILE")" "$CONFIG_DIR"
  local root_escaped wrapper_escaped bun_escaped socket_escaped config_escaped state_escaped
  local relay_escaped log_escaped
  root_escaped="$(plist_escape_value "$PLUGIN_ROOT")"
  wrapper_escaped="$(plist_escape_value "${PLUGIN_ROOT}/scripts/launch-bridge.sh")"
  bun_escaped="$(plist_escape_value "$BUN")"
  socket_escaped="$(plist_escape_value "$SOCKET")"
  config_escaped="$(plist_escape_value "$CONFIG_DIR")"
  state_escaped="$(plist_escape_value "$PLUGIN_STATE_DIR")"
  relay_escaped="$(plist_escape_value "$RELAY_SOCKET")"
  log_escaped="$(plist_escape_value "${CONFIG_DIR}/rad-herdr-mobile-relay.log")"
  cat > "$LAUNCHD_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${wrapper_escaped}</string></array>
  <key>WorkingDirectory</key><string>${root_escaped}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERDR_RELAY_LAUNCH_BUN</key><string>${bun_escaped}</string>
    <key>HERDR_RELAY_LAUNCH_SOCKET_PATH</key><string>${socket_escaped}</string>
    <key>HERDR_RELAY_SOCKET</key><string>${relay_escaped}</string>
    <key>HERDR_PLUGIN_CONFIG_DIR</key><string>${config_escaped}</string>
    <key>HERDR_PLUGIN_STATE_DIR</key><string>${state_escaped}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${log_escaped}</string>
  <key>StandardErrorPath</key><string>${log_escaped}</string>
</dict>
</plist>
EOF
  chmod 600 "$LAUNCHD_FILE"
}

write_unit() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$UNIT_FILE")" "$CONFIG_DIR"
  local bun_escaped root_escaped socket_escaped config_escaped relay_escaped state_environment=""
  relay_escaped="$(systemd_escape_value "$RELAY_SOCKET")"
  bun_escaped="$(systemd_escape_value "$BUN")"
  root_escaped="$(systemd_escape_value "$PLUGIN_ROOT")"
  socket_escaped="$(systemd_escape_value "$SOCKET")"
  config_escaped="$(systemd_escape_value "$CONFIG_DIR")"
  if [ -n "$PLUGIN_STATE_DIR" ]; then
    state_environment="Environment=\"HERDR_PLUGIN_STATE_DIR=$(systemd_escape_value "$PLUGIN_STATE_DIR")\""
  fi
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Herdr Mobile Relay
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${root_escaped}
ExecStart=${bun_escaped} run ${root_escaped}/bridge/index.ts
Restart=on-failure
RestartSec=5
# SSH must see the owner's socket, including explicit /tmp overrides; no PrivateTmp namespace.
# Restrict new state/socket files and deny privilege escalation.
NoNewPrivileges=yes
UMask=0077
Environment="HERDR_SOCKET_PATH=${socket_escaped}"
Environment="HERDR_RELAY_SOCKET=${relay_escaped}"
Environment="HERDR_PLUGIN_CONFIG_DIR=${config_escaped}"
${state_environment}
EnvironmentFile=-${config_escaped}/.env

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

cmd_start() {
  if have_systemd; then
    write_unit
    systemctl --user enable --now "$UNIT"
    echo "bridge started (systemd --user: ${UNIT})"
  elif have_launchd; then
    write_launchd_agent
    local domain; domain="$(launchd_domain)"
    launchctl bootout "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$LAUNCHD_FILE"
    echo "bridge started (launchd user agent: ${LAUNCHD_LABEL})"
  else
    # Last-resort fallback for platforms with neither systemd user services nor launchd.
    mkdir -p "$CONFIG_DIR"
    [ -n "$BUN" ] || { echo "error: bun not found" >&2; exit 1; }
    local pidfile="${CONFIG_DIR}/rad-herdr-mobile-relay.pid" existing_pid=""
    if [ -f "$pidfile" ]; then existing_pid="$(cat "$pidfile" 2>/dev/null || true)"; fi
    if pid_is_bridge "$existing_pid"; then
      echo "bridge already running (pid ${existing_pid}, no systemd)"
    else
      if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        echo "error: pidfile points to a different live process (${existing_pid}); refusing to overwrite it" >&2
        exit 1
      fi
      rm -f "$pidfile"
      HERDR_SOCKET_PATH="$SOCKET" HERDR_RELAY_SOCKET="$RELAY_SOCKET" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" \
        nohup "$BUN" run "${PLUGIN_ROOT}/bridge/index.ts" >>"${CONFIG_DIR}/rad-herdr-mobile-relay.log" 2>&1 &
      local new_pid=$!
      sleep 0.2
      if ! pid_is_bridge "$new_pid"; then
        echo "error: bridge failed to stay running; see ${CONFIG_DIR}/rad-herdr-mobile-relay.log" >&2
        exit 1
      fi
      printf '%s\n' "$new_pid" > "$pidfile"
      echo "bridge started (pid ${new_pid}, no systemd)"
    fi
  fi
  if ! bridge_ready; then
    echo "error: relay did not pass its Unix socket readiness probe" >&2
    return 1
  fi
  print_status_banner
}

cmd_stop() {
  if have_systemd; then
    if ! systemctl --user disable --now "$UNIT" 2>/dev/null; then
      if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
        echo "error: systemd could not stop ${UNIT}; refusing to continue" >&2
        return 1
      fi
    fi
    if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
      echo "error: ${UNIT} is still active after stop" >&2
      return 1
    fi
  elif have_launchd; then
    local domain; domain="$(launchd_domain)"
    if launchctl print "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
      launchctl bootout "${domain}/${LAUNCHD_LABEL}"
    fi
    # Leaving a RunAtLoad plist behind would silently restart this remote-access service at login.
    # `start` always regenerates it, so removal is the durable launchd equivalent of systemd disable.
    rm -f "$LAUNCHD_FILE"
  elif [ -f "${CONFIG_DIR}/rad-herdr-mobile-relay.pid" ]; then
    local pid; pid="$(cat "${CONFIG_DIR}/rad-herdr-mobile-relay.pid" 2>/dev/null || true)"
    if pid_is_bridge "$pid"; then
      if ! stop_bridge_pid "$pid"; then
        echo "error: bridge process ${pid} did not exit; keeping pidfile" >&2
        return 1
      fi
    elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "warning: pidfile points to a different live process (${pid}); not killing it" >&2
    fi
    rm -f "${CONFIG_DIR}/rad-herdr-mobile-relay.pid"
  fi
  echo "bridge stopped"
}

cmd_restart() { cmd_stop; cmd_start; }

# Tear the service down completely (the inverse of `start`): stop + disable it, remove the
# systemd/launchd user service and pidfile. Deliberately leaves your
# config (${CONFIG_DIR}/.env) and the on-disk checkout in place — `uninstall` removes only what
# `start` created. To remove the plugin registration too, run `herdr plugin uninstall rad.herdr-mobile-relay`
# (or, for a linked clone, just delete the checkout).
cmd_uninstall() {
  cmd_stop
  if have_systemd; then
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  fi
  if have_launchd; then rm -f "$LAUNCHD_FILE"; fi
  rm -f "${CONFIG_DIR}/rad-herdr-mobile-relay.pid"
  echo "✓ uninstalled: service stopped & disabled, service definition removed (no network publishing configured)"
  echo "  kept: ${CONFIG_DIR}/.env and the checkout — delete those to remove every trace"
}

managed_reinstall_command() {
  [ -n "$BUN" ] && command -v herdr >/dev/null || return 0
  herdr plugin list --plugin "$PLUGIN_ID" --json 2>/dev/null | "$BUN" -e "$(
    cat <<'BUN_SCRIPT'
    let raw = "";
    process.stdin.on("data", (chunk) => raw += chunk).on("end", () => {
      try {
        const envelope = JSON.parse(raw);
        const plugin = envelope?.result?.plugins?.find((entry) => entry.plugin_id === "rad.herdr-mobile-relay");
        const source = plugin?.source;
        if (!source?.owner || !source?.repo) return;
        const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
        const locator = [source.owner, source.repo, source.subdir].filter(Boolean).join("/");
        const ref = source.requested_ref ? ` --ref ${quote(source.requested_ref)}` : "";
        process.stdout.write(`herdr plugin install ${quote(locator)}${ref} --yes`);
      } catch {}
    });
BUN_SCRIPT
  )"
}

# Update a linked checkout in place. Herdr-managed installs are detached/pinned and get explicit
# reinstall instructions instead. The pull can rewrite THIS script, and bash reads scripts by byte
# offset, so we re-exec the freshly-pulled copy to run build + restart.
cmd_update() {
  if ! git -C "$PLUGIN_ROOT" symbolic-ref --quiet --short HEAD >/dev/null; then
    local reinstall; reinstall="$(managed_reinstall_command)"
    [ -n "$reinstall" ] || reinstall="herdr plugin install <owner>/<repo>[/subdir] --yes"
    echo "error: this is a Herdr-managed checkout pinned at a detached commit; it cannot safely self-update with git pull." >&2
    echo "reinstall it from the same managed source:" >&2
    echo "  herdr plugin uninstall ${PLUGIN_ID}" >&2
    echo "  ${reinstall}" >&2
    return 1
  fi
  echo "updating Herdr Mobile Relay (git pull --ff-only)…"
  git -C "$PLUGIN_ROOT" pull --ff-only
  exec bash "${PLUGIN_ROOT}/scripts/relay-ctl.sh" _apply-update
}

# After an update, Herdr's plugin registry still has the action set + version CACHED from the last
# `plugin link` — so a newly added action (e.g. `version`) returns `plugin_action_not_found`, and
# `herdr plugin list` shows the old version, until a re-link. Re-link here so `update` self-heals it.
# Best-effort: never fails the update (Herdr may be down, or this may be a non-link install) — it just
# prints how to do it by hand.
refresh_registry() {
  command -v herdr >/dev/null || return 0
  if herdr plugin link "$PLUGIN_ROOT" >/dev/null 2>&1; then
    echo "herdr registry refreshed (re-linked) — new actions are invokable now"
  else
    echo "note: couldn't refresh the Herdr registry (is the Herdr server running?) —"
    echo "      run: herdr plugin link \"$PLUGIN_ROOT\""
  fi
}

# Second half of `update`, run from the just-pulled script. cmd_build re-runs the version gate (a
# half-bumped release can't go live) and reinstalls dependencies/typechecks; cmd_restart picks up any
# bridge/ changes; refresh_registry re-links so Herdr learns any newly added actions / the new version.
cmd_apply_update() {
  cmd_build
  cmd_restart
  refresh_registry
  echo "✓ update complete"
}


cmd_status() { print_status_banner; }
cmd_logs() {
  if have_systemd; then journalctl --user -u "$UNIT" -n 80 --no-pager;
  else tail -80 "${CONFIG_DIR}/rad-herdr-mobile-relay.log"; fi
}
main() {
  case "${1:-status}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    uninstall) cmd_uninstall ;;
    update) cmd_update ;;
    _apply-update) cmd_apply_update ;;
    build) cmd_build ;;
    status) cmd_status ;;
    socket|url) printf '%s\n' "$RELAY_SOCKET" ;;
    version) relay_version ;;
    logs) cmd_logs ;;
    *) echo "usage: relay-ctl.sh {start|stop|restart|uninstall|update|version|build|status|socket|logs}" >&2; return 2 ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
