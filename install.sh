#!/usr/bin/env bash
#
# QodeX one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/QodeXcli/QodeX/main/install.sh | bash
#
# What it does: checks for git + Node 20+ (installs Node via the system package manager
# when it's missing or too old), clones (or updates) QodeX, builds it, and puts `qodex`
# and `qx` on your PATH. Idempotent — safe to re-run to update.
#
# Knobs (env vars):
#   QODEX_SRC_DIR    where to clone the source     (default: $HOME/.qodex-src)
#   QODEX_BRANCH     branch to install             (default: main)
#   QODEX_NO_LINK    set to 1 to skip the PATH link (default: link)
#   QODEX_DRY_RUN    set to 1 to print steps without running them (for testing)
#
set -euo pipefail

REPO_URL="${QODEX_REPO_URL:-https://github.com/QodeXcli/QodeX.git}"
SRC_DIR="${QODEX_SRC_DIR:-$HOME/.qodex-src}"
BRANCH="${QODEX_BRANCH:-main}"
DRY_RUN="${QODEX_DRY_RUN:-0}"
MIN_NODE_MAJOR=20

# ── pretty output ──────────────────────────────────────────────────────────────
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Run a side-effecting command — or just print it in dry-run mode.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  + %s\n' "$*"; return 0; fi
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── platform detection ─────────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin) echo macos ;;
    Linux)  if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then echo wsl; else echo linux; fi ;;
    *)      echo unknown ;;
  esac
}

pkg_manager() {
  if have apt-get; then echo apt
  elif have dnf;   then echo dnf
  elif have pacman;then echo pacman
  elif have brew;  then echo brew
  else echo none; fi
}

# ── prerequisites ──────────────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

install_node() {
  local pm; pm="$(pkg_manager)"
  info "Node 20+ not found — installing via $pm …"
  case "$pm" in
    brew)   run brew install node ;;
    apt)    run bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" && run sudo apt-get install -y nodejs ;;
    dnf)    run sudo dnf install -y nodejs ;;
    pacman) run sudo pacman -S --noconfirm nodejs npm ;;
    *)      die "No supported package manager found. Install Node 20+ from https://nodejs.org and re-run." ;;
  esac
}

ensure_prereqs() {
  bold "1/4  Checking prerequisites"
  have git || die "git is required but not installed. Install git and re-run."
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"

  if ! have node || [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    install_node
  fi
  if [ "$DRY_RUN" != "1" ]; then
    have node || die "Node install did not put 'node' on PATH — open a new shell and re-run."
    [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node $MIN_NODE_MAJOR+ required, found $(node -v). Upgrade and re-run."
  fi
  ok "node $([ "$DRY_RUN" = 1 ] && echo '(skipped in dry-run)' || node -v)"
}

# ── clone / update ─────────────────────────────────────────────────────────────
fetch_source() {
  bold "2/4  Fetching QodeX → $SRC_DIR"
  if [ -d "$SRC_DIR/.git" ]; then
    info "Existing checkout found — updating"
    run git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    run git -C "$SRC_DIR" checkout "$BRANCH"
    run git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
  else
    run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
  fi
  ok "source ready"
}

# ── build ──────────────────────────────────────────────────────────────────────
build() {
  bold "3/4  Installing dependencies & building"
  if [ "$DRY_RUN" = "1" ]; then info "(dry-run) cd $SRC_DIR && npm install && npm run build"; ok "built"; return; fi
  ( cd "$SRC_DIR" && npm install && npm run build )
  ok "built"
}

# ── link onto PATH ─────────────────────────────────────────────────────────────
link_cli() {
  bold "4/4  Linking 'qodex' and 'qx' onto your PATH"
  if [ "${QODEX_NO_LINK:-0}" = "1" ]; then info "QODEX_NO_LINK=1 — skipping"; return; fi

  # Prefer `npm link`; fall back to a user-local bin if the npm prefix needs root.
  if [ "$DRY_RUN" = "1" ]; then info "(dry-run) cd $SRC_DIR && npm link"; ok "linked"; return; fi
  if ( cd "$SRC_DIR" && npm link >/dev/null 2>&1 ); then
    ok "linked via npm"
  else
    warn "npm link needs elevated perms; falling back to ~/.local/bin"
    mkdir -p "$HOME/.local/bin"
    ln -sf "$SRC_DIR/bin/qodex.mjs" "$HOME/.local/bin/qodex"
    ln -sf "$SRC_DIR/bin/qodex.mjs" "$HOME/.local/bin/qx"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ok "linked into ~/.local/bin (already on PATH)" ;;
      *) ok "linked into ~/.local/bin"
         warn "add it to your PATH:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile && source ~/.profile" ;;
    esac
  fi
}

main() {
  bold "QodeX installer"
  local os; os="$(detect_os)"
  [ "$os" = "unknown" ] && warn "Unrecognized OS ($(uname -s)) — continuing, but you may need to install Node manually."
  info "platform: $os   ·   source: $SRC_DIR   ·   branch: $BRANCH$([ "$DRY_RUN" = 1 ] && echo '   ·   DRY RUN')"
  echo

  ensure_prereqs
  fetch_source
  build
  link_cli

  echo
  bold "Done."
  info "Next:  qodex setup        # detect local models & write ~/.qodex/config.yaml"
  info "Then:  qodex              # start, or:  qodex --print \"summarize this repo\""
  [ "$DRY_RUN" = "1" ] && info "(dry run — nothing was installed)"
}

main "$@"
