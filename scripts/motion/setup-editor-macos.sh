#!/usr/bin/env bash
# Motion Director: one-command setup for video editors (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/bloomxpradeep/videoeditorwith_after-effects-motion/main/scripts/motion/setup-editor-macos.sh | bash
#
# or, from a clone of the repository:
#
#   bash scripts/motion/setup-editor-macos.sh
#
# What it does (safe to run again; that is also how you update):
#   1. Installs the helpers with Homebrew: Node.js, git, ffmpeg, yt-dlp, Python.
#   2. Gets (or updates) the Motion Director code and builds it.
#   3. Creates a private Python environment with local Whisper and OpenCV.
#   4. Installs the MCP Bridge panel for After Effects and Premiere Pro.
#   5. Creates the "Motion Studio" folder editors open in the Claude app's Code tab.
#   6. Checks everything and prints what to do next.
#
# Options:
#   --studio PATH     Where to create Motion Studio (default: ~/Motion Studio)
#   --repo URL        Git repository to install from
#   --branch NAME     Branch to install (default: main)
#   --whisper-model M Whisper model to download now: tiny|base|small|medium|large-v3 (default: small)
#   --skip-model      Don't download a Whisper model now (it downloads on first use)
#   --check           Only run the checks
#
# Nothing here sends usage data anywhere.

set -euo pipefail

REPO_URL="${MOTION_REPO_URL:-https://github.com/bloomxpradeep/videoeditorwith_after-effects-motion.git}"
BRANCH="${MOTION_BRANCH:-main}"
STUDIO_DIR="${MOTION_STUDIO_DIR:-$HOME/Motion Studio}"
MOTION_HOME="${MOTION_DIRECTOR_HOME:-$HOME/.motion-director}"
WHISPER_MODEL="small"
DOWNLOAD_MODEL=true
CHECK_ONLY=false
# Test hook: lets CI run the file-writing steps on Linux without Homebrew or Adobe.
TEST_MODE="${MOTION_SETUP_TEST:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --studio) STUDIO_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --whisper-model) WHISPER_MODEL="$2"; shift 2 ;;
    --skip-model) DOWNLOAD_MODEL=false; shift ;;
    --check) CHECK_ONLY=true; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
die() { fail "$1"; exit 1; }

if [[ "$(uname -s)" != "Darwin" && "$TEST_MODE" != "1" ]]; then
  die "This setup is for macOS. (Windows support is planned.)"
fi

APP_DIR="$MOTION_HOME/app"
VENV_DIR="$MOTION_HOME/venv"
CEP_TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP"
PANEL_CONFIG_DIR="$HOME/.premiere-mcp-bridge"
PREMIERE_BRIDGE_DIR="/tmp/premiere-mcp-bridge"
AE_BRIDGE_DIR="/tmp/ae-mcp-bridge"

# If this script lives inside a checkout of the project, install from that checkout.
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  CANDIDATE="$(cd "$(dirname "$SCRIPT_SOURCE")/../.." && pwd)"
  if [[ -f "$CANDIDATE/package.json" ]] && grep -q '"adobe-premiere-pro-mcp"' "$CANDIDATE/package.json"; then
    APP_DIR="$CANDIDATE"
  fi
fi

brew_bin() {
  if command -v brew >/dev/null 2>&1; then command -v brew; return; fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$b" ]] && { echo "$b"; return; }; done
}

python_for_venv() {
  local brew; brew="$(brew_bin || true)"
  if [[ -n "$brew" ]]; then
    for v in 3.12 3.11; do
      local p; p="$("$brew" --prefix "python@$v" 2>/dev/null || true)/bin/python$v"
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
  fi
  for p in python3.12 python3.11 python3; do command -v "$p" >/dev/null 2>&1 && { command -v "$p"; return; }; done
}

# ---------------------------------------------------------------------------- checks

run_checks() {
  step "Checking the setup"
  local problems=0
  local node_bin; node_bin="$(command -v node || true)"
  if [[ -n "$node_bin" ]] && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; then ok "Node.js $(node -v)"; else fail "Node.js 20+ missing"; problems=$((problems+1)); fi
  if command -v ffmpeg >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/ffmpeg || -x /usr/local/bin/ffmpeg ]]; then ok "ffmpeg"; else fail "ffmpeg missing (brew install ffmpeg)"; problems=$((problems+1)); fi
  if command -v yt-dlp >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/yt-dlp || -x /usr/local/bin/yt-dlp ]]; then ok "yt-dlp"; else warn "yt-dlp missing: downloading YouTube references won't work (brew install yt-dlp)"; fi
  if [[ -f "$APP_DIR/dist/index.js" ]]; then ok "Motion Director built ($APP_DIR)"; else fail "Motion Director is not built ($APP_DIR/dist/index.js missing)"; problems=$((problems+1)); fi
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    if "$VENV_DIR/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then ok "Whisper (faster-whisper, runs locally)"; else fail "Whisper not installed in $VENV_DIR"; problems=$((problems+1)); fi
    local cv; cv="$("$VENV_DIR/bin/python" -c 'import cv2; print(cv2.__version__)' 2>/dev/null || true)"
    if [[ "$cv" == 4.* ]]; then ok "OpenCV $cv (face detection)"; elif [[ -n "$cv" ]]; then warn "OpenCV $cv has no face models; reinstall with: $VENV_DIR/bin/pip install 'opencv-python-headless>=4.8,<5'"; else fail "OpenCV missing (face detection)"; problems=$((problems+1)); fi
  else
    fail "Python environment missing ($VENV_DIR)"; problems=$((problems+1))
  fi
  if [[ -f "$CEP_TARGET_DIR/CSXS/manifest.xml" ]] && grep -q 'AEFT' "$CEP_TARGET_DIR/CSXS/manifest.xml"; then ok "MCP Bridge panel installed for After Effects and Premiere"; else fail "MCP Bridge panel not installed for After Effects"; problems=$((problems+1)); fi
  if [[ "$TEST_MODE" != "1" ]]; then
    if [[ "$(defaults read com.adobe.CSXS.11 PlayerDebugMode 2>/dev/null || echo 0)" == "1" ]]; then ok "Adobe extension loading enabled"; else fail "Adobe extension loading not enabled"; problems=$((problems+1)); fi
  fi
  if [[ -f "$STUDIO_DIR/.mcp.json" && -f "$STUDIO_DIR/.claude/skills/motion-director/SKILL.md" ]]; then ok "Motion Studio folder: $STUDIO_DIR"; else fail "Motion Studio folder not set up"; problems=$((problems+1)); fi
  if ls -d /Applications/Adobe\ After\ Effects* >/dev/null 2>&1; then ok "After Effects found: $(ls -d /Applications/Adobe\ After\ Effects* | tail -1 | xargs basename)"; else warn "After Effects not found in /Applications"; fi
  if ls -d /Applications/Adobe\ Premiere\ Pro* >/dev/null 2>&1; then ok "Premiere Pro found (optional)"; else warn "Premiere Pro not found (optional)"; fi
  if command -v blender >/dev/null 2>&1 || [[ -d /Applications/Blender.app ]]; then ok "Blender found (optional, for 3D)"; else printf '  %s-%s Blender not installed (optional, for 3D: brew install --cask blender)\n' "$DIM" "$RESET"; fi
  return $problems
}

if [[ "$CHECK_ONLY" == "true" ]]; then
  run_checks && { printf '\n%sAll good.%s\n' "$GREEN" "$RESET"; exit 0; } || { printf '\n%sSome things need fixing (see above). Running this setup again usually fixes them.%s\n' "$YELLOW" "$RESET"; exit 1; }
fi

printf '%sMotion Director setup%s\n' "$BOLD" "$RESET"
printf 'This installs the tools Claude needs to make motion design videos in After Effects.\n'
printf '%sYou may be asked for your Mac password (for Homebrew). Nothing is sent anywhere.%s\n' "$DIM" "$RESET"

# ---------------------------------------------------------------------------- 1. helpers

step "1/6 Installing helpers (Homebrew)"
if [[ "$TEST_MODE" == "1" ]]; then
  warn "test mode: skipping Homebrew"
else
  BREW="$(brew_bin || true)"
  if [[ -z "$BREW" ]]; then
    echo "  Homebrew is not installed. Installing it now (this is the standard Mac package manager)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    BREW="$(brew_bin || true)"
    [[ -n "$BREW" ]] || die "Homebrew did not install. Install it from https://brew.sh and run this again."
  fi
  eval "$("$BREW" shellenv)"
  want=()
  command -v git >/dev/null 2>&1 || want+=(git)
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then want+=(node); fi
  command -v ffmpeg >/dev/null 2>&1 || want+=(ffmpeg)
  command -v yt-dlp >/dev/null 2>&1 || want+=(yt-dlp)
  [[ -n "$(python_for_venv || true)" ]] && "$(python_for_venv)" -c 'import sys; sys.exit(0 if (3,9) <= sys.version_info[:2] <= (3,12) else 1)' 2>/dev/null || want+=(python@3.12)
  if [[ ${#want[@]} -gt 0 ]]; then
    echo "  Installing: ${want[*]}"
    "$BREW" install "${want[@]}"
  fi
  ok "git, Node.js, ffmpeg, yt-dlp and Python are installed"
fi

# ---------------------------------------------------------------------------- 2. code

step "2/6 Getting Motion Director"
if [[ -d "$APP_DIR/.git" && "$APP_DIR" == "$MOTION_HOME/app" ]]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
  ok "Updated to the latest $BRANCH"
elif [[ -f "$APP_DIR/package.json" ]]; then
  ok "Using this checkout: $APP_DIR"
else
  mkdir -p "$MOTION_HOME"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  ok "Downloaded to $APP_DIR"
fi
if [[ "$TEST_MODE" == "1" && -f "$APP_DIR/dist/index.js" ]]; then
  warn "test mode: using the existing build"
else
  echo "  Building (a minute or two the first time)..."
  ( cd "$APP_DIR" && npm install --no-audit --no-fund --loglevel=error && npm run --silent build ) || die "Build failed. Copy the messages above and send them to whoever set this up for you."
  ok "Built"
fi

# ---------------------------------------------------------------------------- 3. python

step "3/6 Local Whisper and face detection"
PY="$(python_for_venv || true)"
[[ -n "$PY" ]] || die "Python 3 not found."
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PY" -m venv "$VENV_DIR"
fi
if [[ "$TEST_MODE" == "1" ]]; then
  warn "test mode: skipping pip installs"
else
  "$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
  "$VENV_DIR/bin/python" -m pip install --quiet --upgrade faster-whisper 'opencv-python-headless>=4.8,<5'
  ok "Whisper and OpenCV installed in $VENV_DIR"
  if [[ "$DOWNLOAD_MODEL" == "true" ]]; then
    echo "  Downloading the Whisper '$WHISPER_MODEL' model so the first transcription is quick..."
    "$VENV_DIR/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('$WHISPER_MODEL', device='cpu', compute_type='int8')" >/dev/null 2>&1 \
      && ok "Whisper model '$WHISPER_MODEL' ready" \
      || warn "Model download didn't finish; it will download on first use."
  fi
fi

# ---------------------------------------------------------------------------- 4. panel

step "4/6 Installing the MCP Bridge panel (After Effects and Premiere Pro)"
if [[ "$TEST_MODE" != "1" ]]; then
  for v in 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
fi
mkdir -p "$CEP_TARGET_DIR"
# Copy over the live extension so a running panel is not deleted out from under itself.
cp -R "$APP_DIR/cep-plugin/." "$CEP_TARGET_DIR/"
mkdir -p "$PREMIERE_BRIDGE_DIR" "$AE_BRIDGE_DIR"
# Panel settings: the right folder per app, no usage data, no upstream update banner.
PANEL_CONFIG_DIR="$PANEL_CONFIG_DIR" PREMIERE_DIR="$PREMIERE_BRIDGE_DIR" AE_DIR="$AE_BRIDGE_DIR" node -e '
const fs = require("fs"), path = require("path");
const dir = process.env.PANEL_CONFIG_DIR;
fs.mkdirSync(dir, { recursive: true });
for (const [file, temp] of [["config.json", process.env.PREMIERE_DIR], ["config-aeft.json", process.env.AE_DIR]]) {
  const p = path.join(dir, file);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch {}
  Object.assign(cfg, { tempDirectory: temp, telemetry: false, updateCheck: false });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}
'
ok "Panel installed. In After Effects: Window > Extensions > MCP Bridge (CEP)"

# ---------------------------------------------------------------------------- 5. studio

step "5/6 Creating your Motion Studio folder"
mkdir -p "$STUDIO_DIR/projects" "$STUDIO_DIR/.claude/skills"
rm -rf "$STUDIO_DIR/.claude/skills/motion-director"
cp -R "$APP_DIR/skills/motion-director" "$STUDIO_DIR/.claude/skills/motion-director"
cp "$APP_DIR/motion-studio/START HERE.md" "$STUDIO_DIR/START HERE.md"
cp "$APP_DIR/motion-studio/CLAUDE.md" "$STUDIO_DIR/CLAUDE.md"
NODE_BIN="$(command -v node)"
STUDIO_DIR="$STUDIO_DIR" APP_DIR="$APP_DIR" NODE_BIN="$NODE_BIN" VENV_PY="$VENV_DIR/bin/python" \
PREMIERE_DIR="$PREMIERE_BRIDGE_DIR" AE_DIR="$AE_BRIDGE_DIR" MOTION_HOME="$MOTION_HOME" node -e '
const fs = require("fs"), path = require("path");
const e = process.env;
const entry = path.join(e.APP_DIR, "dist", "index.js");
const PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
const common = { PREMIERE_MCP_TELEMETRY: "0", PREMIERE_MCP_UPDATE_CHECK: "0", PATH };
const mcpPath = path.join(e.STUDIO_DIR, ".mcp.json");
let mcp = { mcpServers: {} };
try { mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8")); if (!mcp.mcpServers) mcp.mcpServers = {}; } catch {}
mcp.mcpServers["after-effects"] = {
  command: e.NODE_BIN, args: [entry],
  env: { ...common, PREMIERE_MCP_APP: "aftereffects", AE_TEMP_DIR: e.AE_DIR, MOTION_STUDIO_DIR: e.STUDIO_DIR, MOTION_PYTHON: e.VENV_PY, MOTION_DIRECTOR_HOME: e.MOTION_HOME },
};
mcp.mcpServers["premiere-pro"] = {
  command: e.NODE_BIN, args: [entry],
  env: { ...common, PREMIERE_TEMP_DIR: e.PREMIERE_DIR, PREMIERE_MCP_TOOLSET: "full" },
};
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

const settingsPath = path.join(e.STUDIO_DIR, ".claude", "settings.json");
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {}; } catch {}
settings.enableAllProjectMcpServers = true;
settings.permissions = settings.permissions || {};
const allow = new Set(settings.permissions.allow || []);
for (const rule of ["mcp__after-effects", "mcp__premiere-pro", "Edit(projects/**)", "Edit(STYLE-GUIDE.md)", "Bash(blender:*)"]) allow.add(rule);
settings.permissions.allow = [...allow];
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
'
( cd "$STUDIO_DIR/.claude/skills" && rm -f "$STUDIO_DIR/motion-director-skill.zip" && zip -qr "$STUDIO_DIR/motion-director-skill.zip" motion-director ) || warn "Could not make motion-director-skill.zip (zip missing); the skill is still installed in the folder."
ok "Motion Studio ready: $STUDIO_DIR"

# ---------------------------------------------------------------------------- 6. checks

if run_checks; then
  printf '\n%sSetup complete.%s\n\n' "$GREEN$BOLD" "$RESET"
else
  printf '\n%sSetup finished with problems (see above). Running it again usually fixes them.%s\n\n' "$YELLOW$BOLD" "$RESET"
fi
cat <<EOF
${BOLD}Next:${RESET}
  1. Restart After Effects, then choose ${BOLD}Window > Extensions > MCP Bridge (CEP)${RESET}. It should say Connected.
  2. Open the Claude app, go to the ${BOLD}Code${RESET} tab, and open the folder:
       ${BOLD}$STUDIO_DIR${RESET}
     Approve the "after-effects" and "premiere-pro" connections if Claude asks.
  3. Type: ${BOLD}Let's make a motion design video${RESET}

Read "START HERE.md" in that folder for the full walkthrough. To update later, run this same command again.
EOF
