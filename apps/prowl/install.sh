#!/bin/sh
# Prowl installer for macOS and Linux. Installs whatever is missing (Node.js 18+, Git, the GitHub CLI,
# Claude Code, and the Azure CLI when your tickets are in Azure DevOps), copies Prowl to
# ~/.local/share/prowl, adds a `prowl` command, then runs `prowl --setup` to sign you in.
# Re-run it any time to update Prowl; it skips anything already installed.
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.sh)"
#   sh install.sh [--task-board ado|jira] [--no-setup] [--update]
#
# Run from a URL, it downloads Prowl from GitHub; run as a file, it installs the copy next to it.
# --update is what Prowl runs when it updates itself: no setup, and a short closing message.
set -eu

REPO=darrenxhays/agents
SRC=""
if [ -f "$0" ] && [ "${0##*/}" = install.sh ]; then SRC=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd); fi
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APP="$DATA/prowl"
NODE_DIR="$DATA/prowl-node" # only used when no suitable Node.js is installed
BIN="$HOME/.local/bin"
PROWL_DATA="${PROWL_HOME:-$HOME/.prowl}"
ORIG_PATH="$PATH"
export PATH="$BIN:$NODE_DIR/bin:$PATH"

TASK_BOARD=""
SETUP=1
UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --task-board) TASK_BOARD="${2:-}"; shift 2 ;;
    --no-setup) SETUP=0; shift ;;
    --update) UPDATE=1; SETUP=0; shift ;;
    *) echo "Unknown option: $1 (use --task-board ado|jira, --no-setup, --update)" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m+\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { curl -fsSL --retry 3 "$@"; }
sha256() { if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "this installer is for macOS and Linux; on Windows, double-click install.cmd" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64; GH_ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64; GH_ARCH=arm64 ;;
  *) die "unsupported processor: $(uname -m)" ;;
esac
have curl || die "curl is needed to download the tools"

if [ -z "$SRC" ]; then
  say "Downloading Prowl"
  DOWNLOAD=$(mktemp -d)
  trap 'rm -rf "$DOWNLOAD"' EXIT
  fetch "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xzf - -C "$DOWNLOAD" --strip-components=2 "${REPO#*/}-main/apps/prowl"
  SRC="$DOWNLOAD/prowl"
  [ -f "$SRC/prowl.mjs" ] || die "the download from github.com/$REPO didn't contain Prowl"
fi

# Replacing Prowl's files under a running copy would break the reviews it starts.
if [ -f "$PROWL_DATA/lock" ] && kill -0 "$(cat "$PROWL_DATA/lock")" 2>/dev/null; then
  die "Prowl is running. Quit it (press q) first, then run the installer again."
fi

if [ -z "$TASK_BOARD" ]; then
  if [ -f "$PROWL_DATA/config.json" ]; then
    if grep -q '"taskBoard": "jira"' "$PROWL_DATA/config.json"; then TASK_BOARD=jira; else TASK_BOARD=ado; fi
  else
    printf 'Where are your tickets? 1 = Azure DevOps, 2 = Jira [1]: '
    answer=1
    read -r answer 2>/dev/null </dev/tty || true
    if [ "$answer" = 2 ]; then TASK_BOARD=jira; else TASK_BOARD=ado; fi
  fi
fi
case "$TASK_BOARD" in ado | jira) ;; *) die "--task-board must be ado or jira" ;; esac

# Linux packages (Git, the Jira keyring helper) come from the system package manager, which needs root.
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO=sudo
pkg_install() {
  if have apt-get; then $SUDO apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif have dnf; then $SUDO dnf install -y -q "$@" >/dev/null
  elif have yum; then $SUDO yum install -y -q "$@" >/dev/null
  elif have zypper; then $SUDO zypper --non-interactive --quiet install "$@" >/dev/null
  elif have pacman; then $SUDO pacman -S --noconfirm "$@" >/dev/null
  else return 1
  fi
}

brew_ready() {
  have brew && return 0
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; return 0; fi
  done
  return 1
}
brew_install() {
  if ! brew_ready; then
    say "Installing Homebrew (it asks for your password)"
    /bin/bash -c "$(fetch https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    brew_ready || die "Homebrew didn't install"
  fi
  brew install "$@"
}

node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
if node_ok; then
  ok "Node.js $(node --version)"
elif [ "$OS" = darwin ] && brew_ready; then
  say "Installing Node.js"
  brew_install node
else
  say "Installing Node.js into $NODE_DIR"
  base=https://nodejs.org/dist/latest-v24.x
  sums=$(fetch "$base/SHASUMS256.txt")
  file="node-$(echo "$sums" | sed -n "s/.*  node-\(v[0-9.]*\)-$OS-$ARCH\.tar\.gz$/\1/p" | head -1)-$OS-$ARCH.tar.gz"
  [ "$file" != "node--$OS-$ARCH.tar.gz" ] || die "no Node.js download for $OS-$ARCH"
  tmp=$(mktemp -d)
  fetch -o "$tmp/$file" "$base/$file"
  [ "$(sha256 "$tmp/$file")" = "$(echo "$sums" | awk -v f="$file" '$2 == f { print $1 }')" ] || die "the Node.js download failed its checksum"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
node_ok || die "Node.js 18 or newer still isn't available"

if git --version >/dev/null 2>&1; then
  ok "Git"
elif [ "$OS" = darwin ]; then
  xcode-select --install 2>/dev/null || true
  die "Git comes with Apple's Command Line Tools: finish the install in the dialog that opened, then run this again."
else
  say "Installing Git"
  pkg_install git || die "couldn't install Git; install it with your package manager and run this again"
fi

if have gh; then
  ok "GitHub CLI"
elif [ "$OS" = darwin ] && brew_ready; then
  say "Installing the GitHub CLI"
  brew_install gh
else
  say "Installing the GitHub CLI into $BIN"
  tag=$(fetch -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest)
  ver=${tag##*/v}
  if [ "$OS" = darwin ]; then name="gh_${ver}_macOS_$GH_ARCH"; file="$name.zip"; else name="gh_${ver}_linux_$GH_ARCH"; file="$name.tar.gz"; fi
  url="https://github.com/cli/cli/releases/download/v$ver"
  tmp=$(mktemp -d)
  fetch -o "$tmp/$file" "$url/$file"
  [ "$(sha256 "$tmp/$file")" = "$(fetch "$url/gh_${ver}_checksums.txt" | awk -v f="$file" '$2 == f { print $1 }')" ] || die "the GitHub CLI download failed its checksum"
  if [ "$OS" = darwin ]; then (cd "$tmp" && unzip -q "$file"); else tar -xzf "$tmp/$file" -C "$tmp"; fi
  mkdir -p "$BIN" && cp "$tmp/$name/bin/gh" "$BIN/gh" && chmod +x "$BIN/gh"
  rm -rf "$tmp"
fi

if have claude; then
  ok "Claude Code"
else
  say "Installing Claude Code"
  fetch https://claude.ai/install.sh | bash
  have claude || die "Claude Code didn't install"
fi

if [ "$TASK_BOARD" = ado ]; then
  if have az; then
    ok "Azure CLI"
  elif [ "$OS" = darwin ]; then
    say "Installing the Azure CLI"
    brew_install azure-cli
  elif have apt-get; then
    say "Installing the Azure CLI (it asks for your password)"
    fetch https://aka.ms/InstallAzureCLIDeb | $SUDO bash
  else
    say "Installing the Azure CLI (accept the suggested folders)"
    fetch https://aka.ms/InstallAzureCli | bash
    export PATH="$HOME/bin:$PATH"
  fi
  have az || die "the Azure CLI didn't install; see https://aka.ms/installazurecli"
elif [ "$OS" = linux ] && ! have secret-tool; then
  # Where the Jira API token is kept. Without it (or without a desktop keyring), use JIRA_API_TOKEN instead.
  say "Installing secret-tool, for keeping your Jira API token in the keyring"
  pkg_install libsecret-tools 2>/dev/null || pkg_install libsecret 2>/dev/null || echo "  (skipped: set JIRA_API_TOKEN in your environment instead)"
fi

say "Installing Prowl into $APP"
if [ "$SRC" != "$APP" ]; then
  case "$APP" in */prowl) ;; *) die "unexpected install folder: $APP" ;; esac
  rm -rf "$APP"
  mkdir -p "$APP"
  cp -R "$SRC/." "$APP/"
fi
mkdir -p "$BIN"
cat >"$BIN/prowl" <<EOF
#!/bin/sh
# Prowl's launcher. gh and claude may live in ~/.local/bin, which not every shell has on its PATH.
PATH="$BIN:\$PATH" exec "$(command -v node)" "$APP/prowl.mjs" "\$@"
EOF
chmod +x "$BIN/prowl"
ok "prowl command: $BIN/prowl"

case ":$ORIG_PATH:" in
  *":$BIN:"*) NEW_TERMINAL="" ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      *) rc="$HOME/.profile" ;;
    esac
    if ! grep -q 'Added by the Prowl installer' "$rc" 2>/dev/null; then
      # shellcheck disable=SC2016 # $HOME and $PATH are expanded by the shell that reads the file
      printf '\n# Added by the Prowl installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
      ok "added $BIN to your PATH in $rc"
    fi
    NEW_TERMINAL=" (open a new terminal first)"
    ;;
esac

if [ "$SETUP" = 1 ]; then
  say "Setting up"
  "$BIN/prowl" --setup --task-board "$TASK_BOARD" || true
fi
if [ "$UPDATE" = 1 ]; then
  printf '\n\033[1mProwl is updated.\033[0m\n'
  exit 0
fi
printf '\n\033[1mProwl is installed.\033[0m Start it from any terminal%s with: prowl\n' "$NEW_TERMINAL"
[ "$SETUP" = 1 ] || printf 'First run: prowl --setup\n'
