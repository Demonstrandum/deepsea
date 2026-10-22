#!/bin/bash
# DeepSea bootstrap for a fresh Mac: toolchain, the two public repositories,
# the pinned harness build, and an installed variant (the DeepSea app in the
# Dock). Safe to run again: every step skips what is already there.
#
#   bash bootstrap.sh [--variant release] [--dir ~/ds] [--extras <git url>] [--no-install] [--no-profile]
#
#   --variant <v>   variant to create and install (default: release, "DeepSea")
#   --dir <path>    where the checkouts go (default: ~/ds)
#   --extras <url>  also clone a private extras repository (LAYOUT.md §3) and build its plugins
#   --no-install    stop after the harness build (no variant, app or LaunchAgent)
#   --no-profile    do not add PATH lines and the `dsd` alias to ~/.zprofile
#
# Needs: macOS, an internet connection, and once, the Command Line Tools
# (installed through Apple's dialog if missing; no other administrator access).
set -euo pipefail

VARIANT=release
DIR="$HOME/ds"
EXTRAS=
INSTALL=1
PROFILE=1
FRESH_NODE=0                       # --fresh-node: ignore an installed Node (testing)
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:?--variant needs a name}"; shift 2;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2;;
    --extras) EXTRAS="${2:?--extras needs a git url}"; shift 2;;
    --no-install) INSTALL=0; shift;;
    --no-profile) PROFILE=0; shift;;
    --fresh-node) FRESH_NODE=1; shift;;
    -h|--help) sed -n '2,16p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

NODE_MAJOR=24                      # current LTS; DeepSea needs ^22.19 or >=24
PNPM_VERSION=11.7.0
TOOLS="${DEEPSEA_BOOTSTRAP_TOOLS:-$HOME/.local/share/deepsea-bootstrap}"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this script is for macOS"
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) die "unsupported CPU $(uname -m)";; esac

# --- 1. Command Line Tools: git, cc (the harness's native addon), swiftc (the app) ---
step "Command Line Tools"
clt_ok() { xcode-select -p >/dev/null 2>&1 && /usr/bin/xcrun --find swiftc >/dev/null 2>&1; }
if ! clt_ok; then
  if xcode-select -p >/dev/null 2>&1; then
    # Installed, but the toolchain does not answer: no dialog would come, so say why instead of waiting.
    echo "developer directory: $(xcode-select -p)"
    echo "xcrun --find swiftc: $(/usr/bin/xcrun --find swiftc 2>&1 | tail -1)"
    die "the Command Line Tools are installed but swiftc is not usable; try 'sudo xcode-select --reset' (or reinstall them), then run this again"
  fi
  echo "Installing the Command Line Tools: confirm Apple's dialog, then wait (several minutes)."
  xcode-select --install >/dev/null 2>&1 || true
  waited=0
  until clt_ok; do
    sleep 10; waited=$((waited + 10))
    [ $((waited % 120)) -eq 0 ] && echo "still waiting for the Command Line Tools ($((waited / 60)) min; no dialog? run 'xcode-select --install' yourself)"
  done
fi
echo "ok: $(xcode-select -p); $(git --version)"

# --- 2. Node ---
step "Node"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  local major=${v%%.*} minor; minor=${v#*.}; minor=${minor%%.*}
  [ "$major" -ge 24 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; }
}
if [ "$FRESH_NODE" = 1 ] || ! node_ok; then
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk -v a="darwin-$ARCH.tar.gz" '$2 ~ a"$" {print $2; exit}')
  [ -n "$file" ] || die "no Node $NODE_MAJOR build for darwin-$ARCH at $base"
  dest="$TOOLS/${file%.tar.gz}"
  if [ ! -x "$dest/bin/node" ]; then
    echo "downloading $file"
    mkdir -p "$TOOLS"; tmp=$(mktemp -d)
    curl -fsSL "$base/$file" -o "$tmp/$file"
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')
    got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}')
    [ "$want" = "$got" ] || die "checksum mismatch for $file"
    tar -xzf "$tmp/$file" -C "$TOOLS"; rm -rf "${tmp:?}"
  fi
  ln -sfn "$dest" "$TOOLS/node"
  export PATH="$TOOLS/node/bin:$PATH"
fi
node_ok || die "Node $(node -v 2>/dev/null) is too old"
echo "ok: node $(node -v) at $(command -v node)"

# --- 3. pnpm ---
step "pnpm"
export PATH="$TOOLS/pnpm/bin:$PATH"
if [ "$(cd / && pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  npm install --global --silent --prefix "$TOOLS/pnpm" "pnpm@$PNPM_VERSION"
  hash -r
fi
echo "ok: pnpm $(pnpm --version) at $(command -v pnpm)"

# --- 4. The repositories (public; the harness clone is a few hundred MB) ---
step "Repositories in $DIR"
mkdir -p "$DIR"
clone() {  # <name> <url>
  local d="$DIR/$1"
  if [ -d "$d/.git" ]; then
    echo "$1: present; fetching"
    local local_only; local_only=$(git -C "$d" rev-list HEAD --not --remotes 2>/dev/null)   # before the fetch moves them
    git -C "$d" fetch --quiet --tags origin
    if git -C "$d" rev-parse --verify --quiet '@{upstream}' >/dev/null && [ -z "$(git -C "$d" status --porcelain --untracked-files=no)" ]; then
      if [ -z "$local_only" ]; then
        git -C "$d" reset --quiet --hard '@{upstream}'      # topic and integration branches are rebuilt upstream
      else
        echo "$1: has commits that are on no remote branch; left as it is"
      fi
    fi
  else
    git clone --quiet "$2" "$d"
  fi
  # The default branch, checked out locally (repairs a clone that was interrupted).
  git -C "$d" remote set-head origin --auto >/dev/null 2>&1 || true
  local def; def=$(git -C "$d" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || die "$1: cannot read origin's default branch"
  def=${def#origin/}
  if ! git -C "$d" rev-parse --verify --quiet "refs/heads/$def" >/dev/null; then
    git -C "$d" checkout --quiet -B "$def" "origin/$def"
  fi
  echo "$1: $def at $(git -C "$d" rev-parse --short "$def")"
}
clone deepsea-harness https://github.com/taliesinb/deepsea-harness.git
clone deepsea https://github.com/taliesinb/deepsea.git
pin=$(awk '/^commit/{print $2}' "$DIR/deepsea/harness.lock")
git -C "$DIR/deepsea-harness" cat-file -e "$pin^{commit}" 2>/dev/null || die "the pinned harness commit $pin is not in deepsea-harness"

if [ -n "$EXTRAS" ]; then
  if [ -d "$DIR/deepsea-extras/.git" ] || git clone --quiet "$EXTRAS" "$DIR/deepsea-extras" 2>/dev/null; then
    echo "deepsea-extras: present"
  else
    echo "deepsea-extras: cannot clone $EXTRAS (access?); continuing without it"
    EXTRAS=
  fi
fi

# --- 5. The harness build (several minutes the first time) ---
step "Harness build"
DSD="$DIR/deepsea/tools/dsd/bin/dsd.mjs"
node "$DSD" link >/dev/null
echo "ok: $(readlink "$DIR/deepsea/harness")"

if [ -n "$EXTRAS" ]; then
  for p in "$DIR"/deepsea-extras/plugins/*/; do
    [ -f "$p/package.json" ] || { echo "extras: skipping $(basename "$p") (its checkout is not here)"; continue; }
    (cd "$p" && pnpm install --silent >/dev/null && { ! grep -q '"build"' package.json || pnpm run --silent build >/dev/null 2>&1; }) \
      && echo "extras: built $(basename "$p")" || echo "extras: $(basename "$p") failed to build; skipped"
  done
fi

# --- 6. Shell profile ---
if [ "$PROFILE" = 1 ]; then
  step "~/.zprofile"
  marker="# >>> deepsea bootstrap >>>"
  if ! grep -qF "$marker" "$HOME/.zprofile" 2>/dev/null; then
    {
      printf '\n%s\n' "$marker"
      [ -d "$TOOLS/node" ] && printf 'export PATH="%s/node/bin:$PATH"\n' "$TOOLS"
      printf 'export PATH="%s/pnpm/bin:$PATH"\n' "$TOOLS"
      printf "alias dsd='node \"%s\"'\n" "$DSD"
      printf '# <<< deepsea bootstrap <<<\n'
    } >> "$HOME/.zprofile"
    echo "added PATH and the dsd alias (new terminals)"
  else
    echo "already set up"
  fi
fi

# --- 7. The variant: its home, app, server host and relay ---
if [ "$INSTALL" = 0 ]; then
  step "Done (no variant installed: --no-install)"
  exit 0
fi
step "Variant $VARIANT"
if ! node "$DSD" list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$VARIANT"; then
  node "$DSD" new "$VARIANT" >/dev/null
  echo "created $VARIANT"
fi
node "$DSD" build "$VARIANT" --install --dock > "$TOOLS/build-$VARIANT.json"
app=$(node -p "require('$TOOLS/build-$VARIANT.json').app")
url=$(node -p "require('$TOOLS/build-$VARIANT.json').url ?? ''")

step "Done"
echo "App: $app (in the Dock)"
[ -n "$url" ] && echo "URL: $url"
echo "Model providers: sign in or add keys in the app's Settings."
open "$app"
