#!/bin/bash

# Auto Git Commit and Push Script by BeyondTS
# 智谱AI邀请：https://www.bigmodel.cn/invite?icode=i1hBPobA%2Bmtg8XS3qmwhTUjPr3uHog9F4g5tjuOUqno%3D
# MiniMax邀请：https://platform.minimaxi.com/subscribe/coding-plan?code=2685TjN0NW&source=link

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ======================================= [本地 .env 文件支持]
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// /}" ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            value="${value#\"}"; value="${value%\"}"
            value="${value#\'}"; value="${value%\'}"
            if ! eval "[ -n \"\${$key+x}\" ]"; then
                export "$key=$value"
            fi
        fi
    done < "$ENV_FILE"
fi
# ======================================= [调试选项]
DEBUG_MODE=${DEBUG_MODE:-false}
# ======================================= [KDE Wallet 集成]
KWALLET_NAME="kdewallet"
KWALLET_FOLDER="api_keys"
KWALLET_ENTRY="SILICON_API_KEY"
# ======================================= [LLM配置]
BASE_URL=${BASE_URL:-"https://api.siliconflow.cn/v1"}
LLM_MODEL=${LLM_MODEL:-"Qwen/Qwen3-30B-A3B-Instruct-2507"}

# 从 KDE Wallet 获取 API Key（需钱包已解锁）
get_api_key_from_kwallet() {
    if ! command -v kwalletcli &>/dev/null; then
        return 1
    fi
    local api_key
    api_key=$(kwalletcli -e "$KWALLET_ENTRY" -f "$KWALLET_FOLDER" 2>/dev/null)

    if [[ $? -eq 0 && -n "$api_key" ]]; then
        echo "$api_key"
        return 0
    fi

    return 1
}

# 获取 API Key（优先 KDE Wallet，其次环境变量 / .env 文件）
apiKey=$(get_api_key_from_kwallet)
if [ -z "$apiKey" ]; then
    apiKey="${SILICON_API_KEY:-${API_KEY:-}}"
fi
# Check API key before proceeding
if [ -z "$apiKey" ]; then
    echo -e "${RED}Error: API key is not configured.${NC}" >&2
    echo -e "${YELLOW}Please ensure one of the following:${NC}" >&2
    echo -e "  1. KDE Wallet is unlocked and entry exists:" >&2
    echo -e "       Wallet: $KWALLET_NAME, Folder: $KWALLET_FOLDER, Entry: $KWALLET_ENTRY" >&2
    echo -e "  2. Create a .env file next to this script with:${NC}" >&2
    echo -e "       SILICON_API_KEY=your_api_key" >&2
    exit 1
fi

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

LLM_PROMPT_TEMPLATE='根据Git diff生成commit message。禁止任何分析、解释、说明。
Git Diff:
%s
输出格式：
{描述}:
- {文件1}: {改动1}
- {文件2}: {改动2}
...
参数说明：
描述: 20字内,动词开头,禁止废话,
文件n: 相对路径全名(文件1 != 文件2 != 文件3...)
改动: 50字内,动词开头,禁止废话
注意每一个 - {文件n}: {改动n}单独占用一行，也不要有空行'

# Function to check and clear any existing Git processes and lock files
clear_git_processes() {
    # Check for running git processes
    echo -e "${CYAN}Checking for existing Git processes...${NC}"
    git_pids=$(pgrep -x git 2>/dev/null)

    if [ -n "$git_pids" ]; then
        echo -e "${YELLOW}Found running Git process(es). Attempting to clear...${NC}"
        echo "$git_pids" | while read pid; do
            echo -e "${YELLOW}  Stopping Git process (PID: $pid)...${NC}"
            # Disown the process first to prevent "Killed" message from shell
            if jobs -p | grep -q "^${pid}$" 2>/dev/null; then
                disown "$pid" 2>/dev/null
            fi
            kill -9 "$pid" 2>/dev/null
        done
        sleep 2

        remaining_git_pids=$(pgrep -x git 2>/dev/null)
        if [ -n "$remaining_git_pids" ]; then
            echo -e "${RED}Warning: Could not stop all Git processes. Some operations might fail.${NC}"
        else
            echo -e "${GREEN}All Git processes cleared successfully.${NC}"
        fi
    else
        echo -e "${GREEN}No existing Git processes detected.${NC}"
    fi

    # Check and remove git lock files
    echo -e "${CYAN}Checking for Git lock files...${NC}"
    gitDir=".git"
    lockFiles=()

    # Index lock file
    if [ -f "$gitDir/index.lock" ]; then
        lockFiles+=("$gitDir/index.lock")
    fi

    # Check for other possible lock files in .git directory
    if [ -d "$gitDir" ]; then
        while IFS= read -r file; do
            lockFiles+=("$file")
        done < <(find "$gitDir" -name "*.lock" -type f 2>/dev/null)
    fi

    # Remove lock files if found
    if [ ${#lockFiles[@]} -gt 0 ]; then
        echo -e "${YELLOW}Found ${#lockFiles[@]} Git lock file(s). Removing...${NC}"
        for lockFile in "${lockFiles[@]}"; do
            echo -e "${YELLOW}  Removing lock file: $lockFile${NC}"
            rm -f "$lockFile"
            if [ -f "$lockFile" ]; then
                echo -e "${RED}  Failed to remove lock file: $lockFile${NC}"
            else
                echo -e "${GREEN}  Successfully removed lock file: $lockFile${NC}"
            fi
        done
    else
        echo -e "${GREEN}No Git lock files detected.${NC}"
    fi
}

# Function to get git diff in a structured format
get_git_changes() {
    stagedFiles=$(git diff --staged --name-status)
    if [ -z "$stagedFiles" ]; then
        return 1
    fi

    added=()
    modified=()
    deleted=()

    while IFS= read -r line; do
        status=$(echo "$line" | cut -c1)
        file=$(echo "$line" | cut -c3-)
        case "$status" in
            A) added+=("$file") ;;
            M) modified+=("$file") ;;
            D) deleted+=("$file") ;;
        esac
    done <<< "$stagedFiles"
}

# Function to get detailed diff content
get_detailed_diff() {
    diff=$(git diff --staged --patch)
    if [ -z "$diff" ]; then
        echo "No changes detected"
    else
        echo "$diff"
    fi
}

# Function to generate commit message using LLM
get_llm_commit_message() {
    local diffContent="$1"
    local prompt=$(printf "$LLM_PROMPT_TEMPLATE" "$diffContent")

    local maxRetries=3
    local retryCount=0

    while [ $retryCount -lt $maxRetries ]; do
        echo -e "${CYAN}Model in use: $LLM_MODEL${NC}" >&2
        if [ -z "$apiKey" ]; then
            echo -e "${RED}Error: Environment variable MINIMAX_API_KEY is not set.${NC}" >&2
            return 1
        fi

        # Prepare JSON payload via stdin (avoids cmd length limits on Windows)
        jsonPayload=$(printf '%s\x00%s' "$prompt" "$LLM_MODEL" | python3 -c "import json,sys; p,m=sys.stdin.read().split('\x00'); print(json.dumps({'model':m,'messages':[{'role':'user','content':p}],'top_p':0.7,'temperature':0.9},ensure_ascii=False))")

        apiUrl="${BASE_URL}/chat/completions"

        response=$(curl -s -X POST "$apiUrl" \
            -H "Authorization: Bearer $apiKey" \
            -H "Content-Type: application/json" \
            -d "$jsonPayload" 2>/dev/null)

        if [ $? -eq 0 ] && [ -n "$response" ]; then
            # Extract response content using Python via stdin
            commitMessage=$(printf '%s' "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','') or '')")

            if [ -n "$commitMessage" ]; then
                # Debug: print raw message before filtering
                if [ "$DEBUG_MODE" = true ]; then
                    echo -e "${YELLOW}[Debug] Raw LLM response before filtering:${NC}" >&2
                    echo "$commitMessage" >&2
                    echo "" >&2
                fi

                # Step 1: Remove content between <think> and </think> tags (including the tags)
                commitMessage=$(echo "$commitMessage" | sed -E '/<think>/,/<\/think>/d')

                # Step 2: Keep lines that look like commit message:
                # - Description line: ends with : or ： but doesn't contain analysis keywords
                # - File list line: starts with -
                commitMessage=$(echo "$commitMessage" | grep -E '(^\s*- |[：:]$)' | grep -vE '(应该|需要|是|关键|主要|分析|按照|根据|让我|描述|文件|改动|变化)[：:]$')
                # Step 3: Remove template placeholder lines like {描述}: {文件1}:
                commitMessage=$(echo "$commitMessage" | sed -E '/\{[^}]+\}[：:]$/d')

                # Step 4: Clean up whitespace
                commitMessage=$(echo "$commitMessage" | sed -E 's/^[ \t]+//')
                commitMessage=$(echo "$commitMessage" | sed '/./,$!d' | tac | sed '/./,$!d' | tac)

                # Debug: print after filtering
                if [ "$DEBUG_MODE" = true ]; then
                    echo -e "${YELLOW}[Debug] After filtering:${NC}" >&2
                    echo "$commitMessage" >&2
                    echo "" >&2
                fi

                echo "$commitMessage"
                return 0
            fi
        fi

        retryCount=$((retryCount + 1))
        if [ $retryCount -lt $maxRetries ]; then
            echo -e "${YELLOW}LLM request failed, retrying ($retryCount/$maxRetries)...${NC}" >&2
            sleep $((2 * retryCount))
        else
            echo -e "${RED}Failed to generate LLM commit message after $maxRetries retries${NC}" >&2
            return 1
        fi
    done

    return 1
}

# Main script execution

# Clear any existing Git processes and lock files before proceeding
clear_git_processes

# Auto stage all changes
echo ""
echo -e "${CYAN}Automatically staging all changes...${NC}"
git add -A
if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to stage files${NC}"
    exit 1
fi
echo -e "${GREEN}Files staged successfully${NC}"

# Check staged changes
echo ""
echo -e "${CYAN}Starting to check Git changes...${NC}"
get_git_changes
if [ $? -ne 0 ]; then
    # 检查是否有未推送的提交
    unpushed=$(git log --branches --not --remotes --oneline 2>/dev/null)
    if [ -n "$unpushed" ]; then
        echo -e "${YELLOW}No new changes to commit, but found unpushed commits:${NC}"
        echo "$unpushed"
        echo ""
        echo -e "${CYAN}Pushing unpushed commits to remote...${NC}"
        if git push --all origin 2>&1; then
            echo -e "${GREEN}Commits pushed successfully${NC}"
            echo '{"success":true,"message":"Unpushed commits pushed successfully"}'
        else
            echo -e "${RED}错误：远程推送失败${NC}" >&2
            echo '{"success":false,"message":"Push failed"}'
            exit 1
        fi
    else
        echo -e "${GREEN}No changes detected, nothing to commit.${NC}"
        echo ""
        echo -e "${GREEN}Auto Git commit and push completed with no changes!${NC}"
        echo '{"success":true,"message":"No changes to commit, working tree clean"}'
    fi
    exit 0
fi

diffContent=$(get_detailed_diff)

# Generate commit message using LLM
echo ""
echo -e "${CYAN}Using LLM to analyze changes and generate a commit message...${NC}"
commitMessage=$(get_llm_commit_message "$diffContent")

if [ -z "$commitMessage" ]; then
    currentDate=$(date "+%Y-%m-%d %H:%M:%S")
    commitMessage="LLM invalid, auto backup: $currentDate"
    echo -e "${YELLOW}Using default commit message${NC}"
fi

echo ""
echo -e "${CYAN}Commit message:${NC}"
echo -e "${GREEN}$commitMessage${NC}"

if [ "$DEBUG_MODE" = true ]; then
    echo ""
    echo -e "${YELLOW}[Debug mode] Skipping commit and push operations${NC}"
else
    # Perform commit operation
    echo ""
    echo -e "${CYAN}Creating a commit...${NC}"
    # Write commit message to temp file to avoid quoting issues
    commitMsgFile=$(mktemp)
    echo "$commitMessage" > "$commitMsgFile"
    if git commit -F "$commitMsgFile" 2>&1; then
        rm -f "$commitMsgFile"
        echo -e "${GREEN}Commit created successfully${NC}"
    else
        rm -f "$commitMsgFile"
        echo -e "${RED}错误：提交失败${NC}" >&2
        exit 1
    fi

    echo ""
    echo -e "${CYAN}Pushing all branches to remote...${NC}"
    if git push --all origin 2>&1; then
        echo -e "${GREEN}Branches pushed successfully${NC}"
    else
        echo -e "${RED}错误：远程推送失败，但提交已创建${NC}" >&2
        echo '{"success":false,"message":"Push failed but commit created"}'
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}Auto Git commit and push completed!${NC}"
echo '{"success":true,"message":"Auto Git commit and push completed!"}'
