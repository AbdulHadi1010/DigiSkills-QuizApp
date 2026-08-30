#!/usr/bin/env bash
# =============================================================================
# DigiQuiz — start.sh   (macOS / Linux)
#
#   ./start.sh                 auto-detect Docker, fall back to Node + SQLite
#   ./start.sh --node          force Path B
#   ./start.sh --docker        force Path A
#   ./start.sh --port 8081     use a different port
#   ./start.sh --no-qr         skip the QR code
#
# The Windows equivalent is start.ps1, which is the primary entry point for this
# project. This script is the same flow for Unix-like systems.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

PORT=8080
MODE=auto
QR=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="$2"; shift 2 ;;
    --docker) MODE=docker; shift ;;
    --node)   MODE=node; shift ;;
    --no-qr)  QR=0; shift ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m[ok]\033[0m   %s\n' "$1"; }
warn()  { printf '  \033[33m[warn]\033[0m %s\n' "$1"; }
err()   { printf '  \033[31m[X]\033[0m    %s\n' "$1"; }
head2() { printf '\n\033[36m%s\033[0m\n' "$1"; }

echo
bold "  DigiQuiz - local development stack"
echo  "  ----------------------------------"

# -----------------------------------------------------------------------------
# 1. What is installed?
# -----------------------------------------------------------------------------
head2 "Checking what is installed"

NODE_OK=0; NODE_MAJOR=0; NODE_MINOR=0; NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f2)"
  NODE_OK=1
  ok "Node $NODE_VERSION"
else
  warn "Node not found on PATH"
fi

SQLITE_BUILTIN=0
if [ "$NODE_OK" = "1" ]; then
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; then
    SQLITE_BUILTIN=1
  else
    warn "Node $NODE_VERSION has no built-in SQLite (needs 22.5.0+)"
  fi
fi

DOCKER_OK=0
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    DOCKER_OK=1; ok "Docker is installed and running"
  else
    warn "Docker is installed but not running"
  fi
else
  warn "Docker not found on PATH"
fi

# -----------------------------------------------------------------------------
# 2. Choose a path
# -----------------------------------------------------------------------------
if [ "$MODE" = "auto" ]; then
  if [ "$DOCKER_OK" = "1" ]; then MODE=docker
  elif [ "$NODE_OK" = "1" ]; then MODE=node
  else
    echo; err "Neither Docker nor Node is available."
    echo
    echo "  Install one of these and try again:"
    echo "    * Node.js 22.5+   https://nodejs.org   (or: brew install node)"
    echo "    * Docker Desktop  https://www.docker.com/products/docker-desktop"
    echo
    exit 1
  fi
fi

echo
if [ "$MODE" = "docker" ]; then
  bold "  Using Path A: Docker (MySQL 8 + both tiers in containers)"
else
  bold "  Using Path B: Node + SQLite (no Docker, no MySQL install)"
  if [ "$SQLITE_BUILTIN" != "1" ]; then
    echo; err "Path B needs Node 22.5.0 or newer for its built-in SQLite."
    echo "         You have ${NODE_VERSION:-none}."
    echo "         Upgrade Node, or 'npm install better-sqlite3' (needs a C++ toolchain),"
    echo "         or start Docker and re-run."
    echo
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# 3. LAN IP (Node does the ranking; see tools/lanip.js)
# -----------------------------------------------------------------------------
head2 "Finding your LAN address"
LAN_IP=""
if [ "$NODE_OK" = "1" ]; then
  LAN_IP="$(node -e "process.stdout.write(require('./tools/lanip').detectLanIp()||'')" 2>/dev/null)"
fi
if [ -z "$LAN_IP" ]; then
  # Fallback for a machine with no Node (Docker path only)
  case "$(uname -s)" in
    Darwin) LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)" ;;
    Linux)  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" ;;
  esac
fi
if [ -n "$LAN_IP" ]; then ok "$LAN_IP"; else warn "No LAN address found - is WiFi on?"; fi

export WEB_PORT="$PORT"
[ -n "$LAN_IP" ] && export DIGIQUIZ_LAN_IP="$LAN_IP"
[ "$QR" = "0" ] && export NO_QR=1

QR_ARGS=""
[ "$QR" = "0" ] && QR_ARGS="--no-qr"

# -----------------------------------------------------------------------------
# 4. Firewall guidance (printed up front, because it is the usual culprit)
# -----------------------------------------------------------------------------
show_firewall_help() {
  echo
  printf '\033[33m  If your phone cannot open the page:\033[0m\n'
  echo
  case "$(uname -s)" in
    Darwin)
      echo "  1. macOS firewall. System Settings > Network > Firewall."
      echo "     If it is on, click Options and either allow incoming connections for"
      echo "     'node' (Path B) or 'Docker' (Path A), or switch the firewall off briefly."
      echo "     From the terminal:"
      echo "       sudo /usr/libexec/ApplicationFirewall/socketutil --setglobalstate off"
      echo "     Re-enable afterwards with --setglobalstate on."
      echo "     To allow node specifically instead of disabling the firewall:"
      echo "       sudo /usr/libexec/ApplicationFirewall/socketutil --add \$(which node)"
      echo "       sudo /usr/libexec/ApplicationFirewall/socketutil --unblockapp \$(which node)"
      ;;
    Linux)
      echo "  1. Firewall. If you use ufw:"
      echo "       sudo ufw allow $PORT/tcp"
      echo "     firewalld:"
      echo "       sudo firewall-cmd --add-port=$PORT/tcp"
      ;;
  esac
  echo
  echo "  2. Make sure the phone is on WiFi, not mobile data."
  echo "  3. Guest / corporate WiFi often isolates clients. See DEV-README.md."
  echo
}

# -----------------------------------------------------------------------------
# 5. Start
# -----------------------------------------------------------------------------
if [ "$MODE" = "docker" ]; then
  head2 "Starting containers (first run pulls MySQL and builds two images)"
  if ! docker compose up --build -d; then
    err "docker compose failed. If the port is in use, try: ./start.sh --port 8081"
    exit 1
  fi

  echo
  echo "  Waiting for the stack to become healthy..."
  READY=0
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then READY=1; break; fi
    sleep 2
  done
  if [ "$READY" != "1" ]; then
    err "The stack did not come up in time. Check: docker compose logs"
    exit 1
  fi
  ok "All three containers are healthy"

  if [ "$NODE_OK" = "1" ]; then
    node tools/banner.js --port "$PORT" $QR_ARGS
  else
    echo; echo "  Open on your phone:   http://$LAN_IP:$PORT"; echo
  fi
  show_firewall_help
  echo "  Following container logs. Ctrl+C detaches; containers keep running."
  echo "  Stop everything with:  docker compose down"
  echo
  exec docker compose logs -f
else
  if [ ! -d node_modules ]; then
    head2 "Installing dependencies (three pure-JavaScript packages, no compiler needed)"
    if ! npm install --no-audit --no-fund; then
      err "npm install failed. Are you online?"
      exit 1
    fi
    ok "Dependencies installed"
  fi
  show_firewall_help
  exec node tools/dev.js
fi
