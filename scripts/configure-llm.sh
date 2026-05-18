#!/usr/bin/env bash
# configure-llm.sh — interactive Aurora LLM provider setup
#
# Walks the operator through choosing between:
#   1) Local Ollama (chat + embeddings on the box)
#   2) Ollama Cloud chat + local embeddings (hybrid — recommended for CPU boxes)
#   3) Local Ollama, custom models
#
# Writes the chosen values to server_settings via psql so they survive
# restarts and are visible in the admin UI. Does not touch aurora.env;
# DB settings take precedence at boot (see applyLLMOverrides in main.go).
#
# Re-run any time to change providers. The script is idempotent — it
# upserts each row.

set -euo pipefail

DB_USER="${DB_USER:-aurora}"
DB_NAME="${DB_NAME:-aurora}"
PSQL="psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -X -q -t -A"

# Sanity check: server_settings table must exist (created by phase4 migration).
if ! ${PSQL} -c "SELECT 1 FROM server_settings LIMIT 1" >/dev/null 2>&1; then
    echo "ERROR: server_settings table not found. Has Aurora been initialized?"
    echo "       Run aurora once to apply migrations, then re-run this script."
    exit 1
fi

upsert() {
    local key="$1"
    local value="$2"
    ${PSQL} <<SQL
INSERT INTO server_settings (key, value, updated_by)
VALUES ('${key}', \$\$${value}\$\$, 0)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();
SQL
}

prompt() {
    local label="$1"
    local default="$2"
    local var
    read -rp "${label} [${default}]: " var
    echo "${var:-${default}}"
}

echo
echo "=========================================="
echo "  Aurora LLM Provider Setup"
echo "=========================================="
echo
echo "  1) Local Ollama only"
echo "       Best when you have a GPU. Both chat and embeddings"
echo "       run at http://127.0.0.1:11434."
echo
echo "  2) Ollama Cloud chat + local embeddings (hybrid)"
echo "       Recommended for CPU-only servers. Chat runs on"
echo "       Ollama's hosted infra (fast), embeddings stay local"
echo "       (free, no per-request cost, runs in milliseconds)."
echo
echo "  3) Manual / custom"
echo "       Type your own URLs and model names."
echo

choice=$(prompt "Choose 1-3" "2")

case "${choice}" in
    1)
        provider="local"
        ollama_url="http://127.0.0.1:11434"
        embed_url=""
        chat_model=$(prompt "Chat model" "qwen2.5:1.5b-instruct")
        embed_model=$(prompt "Embed model" "nomic-embed-text")
        api_key=""
        ;;
    2)
        provider="ollama_cloud"
        ollama_url="https://ollama.com"
        embed_url="http://127.0.0.1:11434"
        chat_model=$(prompt "Cloud chat model" "gemma3:12b")
        embed_model=$(prompt "Local embed model" "nomic-embed-text")
        echo
        echo "Paste your Ollama Cloud API key (starts with 'sk-' or similar)."
        echo "It will be stored in the DB; not echoed here."
        read -rsp "API key: " api_key
        echo
        if [ -z "${api_key}" ]; then
            echo "ERROR: API key is required for Ollama Cloud. Aborting."
            exit 1
        fi
        ;;
    3)
        provider=$(prompt "Provider label (informational)" "local")
        ollama_url=$(prompt "Chat URL" "http://127.0.0.1:11434")
        embed_url=$(prompt "Embed URL (blank to reuse chat URL)" "")
        chat_model=$(prompt "Chat model" "qwen2.5:1.5b-instruct")
        embed_model=$(prompt "Embed model" "nomic-embed-text")
        read -rsp "API key (blank to skip): " api_key
        echo
        ;;
    *)
        echo "Invalid choice. Aborting." ; exit 1
        ;;
esac

echo
echo "Writing settings..."
upsert "llm_provider"    "${provider}"
upsert "llm_ollama_url"  "${ollama_url}"
upsert "llm_embed_url"   "${embed_url}"
upsert "llm_chat_model"  "${chat_model}"
upsert "llm_embed_model" "${embed_model}"
if [ -n "${api_key}" ]; then
    upsert "llm_api_key" "${api_key}"
fi

echo
echo "Done. Restart Aurora for the new LLM config to take effect:"
echo "    sudo systemctl restart aurora"
echo
echo "After restart, verify with:"
echo "    journalctl -u aurora -n 50 --no-pager | grep -i ollama"
