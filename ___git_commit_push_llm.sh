#!/bin/bash

# Cross-platform Git Commit and Push Script Router
# Auto-detects OS and delegates to the platform-specific implementation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ======================================= [全局 .env 文件支持]
# Load root-level .env first so platform scripts inherit via environment
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// /}" ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            value="${value%$'\r'}"
            value="${value#\"}"; value="${value%\"}"
            value="${value#\'}"; value="${value%\'}"
            if ! eval "[ -n \"\${$key+x}\" ]"; then
                export "$key=$value"
            fi
        fi
    done < "$ENV_FILE"
fi

# ======================================= [平台检测与路由]
detect_os() {
    case "$(uname -s)" in
        Linux*|Darwin*)          echo "linux" ;;
        CYGWIN*|MINGW*|MSYS*)    echo "windows" ;;
        *)                       echo "unknown" ;;
    esac
}

OS=$(detect_os)

if [ "$OS" = "linux" ]; then
    TARGET="$SCRIPT_DIR/zbak_script/linux/commit/___git_commit_push_llm.sh"
    if [ ! -f "$TARGET" ]; then
        echo "Error: Linux script not found: $TARGET" >&2
        exit 1
    fi
    exec bash "$TARGET"

elif [ "$OS" = "windows" ]; then
    TARGET="$SCRIPT_DIR/zbak_script/win/commit/___git_commit_push_llm.ps1"
    if [ ! -f "$TARGET" ]; then
        echo "Error: Windows script not found: $TARGET" >&2
        exit 1
    fi
    # Prefer pwsh (PowerShell 7+), fallback to powershell (Windows PowerShell)
    if command -v pwsh &>/dev/null; then
        exec pwsh -ExecutionPolicy Bypass -File "$TARGET"
    elif command -v powershell &>/dev/null; then
        exec powershell -ExecutionPolicy Bypass -File "$TARGET"
    else
        echo "Error: PowerShell (pwsh or powershell) not found." >&2
        exit 1
    fi

else
    echo "Error: Unsupported OS '$(uname -s)'. Expected Linux, macOS, or Windows (Git Bash/MSYS)." >&2
    exit 1
fi
