#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Obsidian Plugin Installer ───────────────────────────────────────
# Copies the built plugin into your Obsidian vault's plugins directory.
# Usage: ./install.sh [/path/to/vault]

PLUGIN_ID="openclaw"
REQUIRED_FILES=("main.js" "manifest.json")
OPTIONAL_FILES=("styles.css")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

info()  { printf "${CYAN}ℹ${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET}  %s\n" "$*" >&2; exit 1; }

# ─── Check build artifacts exist ─────────────────────────────────────────────
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "${SCRIPT_DIR}/${f}" ]] || fail "Missing ${f} — run 'npm run build' first."
done

# ─── Resolve vault path ──────────────────────────────────────────────────────
resolve_vault() {
  local vault_path=""

  # 1. Argument passed directly
  if [[ $# -gt 0 && -n "${1:-}" ]]; then
    vault_path="$1"
  else
    # 2. Try obsidian-cli for default vault path
    local cli_path=""
    if command -v obsidian-cli &>/dev/null; then
      cli_path="$(obsidian-cli print-default --path-only 2>/dev/null || true)"
    fi

    if [[ -n "${cli_path}" && -d "${cli_path}" ]]; then
      echo "Detected vault via obsidian-cli: ${cli_path}" >&2
      read -p "Use this vault? [Y/n] " -r answer </dev/tty
      if [[ -z "${answer}" || "${answer}" =~ ^[Yy] ]]; then
        vault_path="${cli_path}"
      fi
    fi

    # 3. Interactive prompt
    if [[ -z "${vault_path}" ]]; then
      printf "${BOLD}Enter the path to your Obsidian vault:${RESET} " >&2
      read -r vault_path </dev/tty
    fi
  fi

  # Expand ~ manually (read doesn't expand it)
  vault_path="${vault_path/#\~/$HOME}"

  echo "${vault_path}"
}

vault_path="$(resolve_vault "$@")"

# ─── Validate ─────────────────────────────────────────────────────────────────
[[ -n "${vault_path}" ]]               || fail "No vault path provided."
[[ -d "${vault_path}" ]]               || fail "Directory does not exist: ${vault_path}"
[[ -d "${vault_path}/.obsidian" ]]     || fail "Not an Obsidian vault (no .obsidian/ directory): ${vault_path}"

# ─── Install ──────────────────────────────────────────────────────────────────
plugin_dir="${vault_path}/.obsidian/plugins/${PLUGIN_ID}"

if [[ ! -d "${plugin_dir}" ]]; then
  mkdir -p "${plugin_dir}"
  info "Created ${plugin_dir}"
fi

copied=0
for f in "${REQUIRED_FILES[@]}" "${OPTIONAL_FILES[@]}"; do
  src="${SCRIPT_DIR}/${f}"
  if [[ -f "${src}" ]]; then
    cp "${src}" "${plugin_dir}/${f}"
    ok "Copied ${f}"
    ((copied++))
  fi
done

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}Installed ${PLUGIN_ID} → ${plugin_dir}${RESET}\n"
echo ""
echo "Next steps:"
echo "  1. Restart Obsidian (or reload without restart: Ctrl/Cmd+R)"
echo "  2. Go to Settings → Community Plugins"
echo "  3. Enable \"OpenClaw\""
echo "  4. Configure your gateway URL and token in Settings → OpenClaw"
echo ""
