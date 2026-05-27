# Auto Git Commit and Push Script by BeyondTS
using namespace System.Web
# 智谱AI邀请：https://www.bigmodel.cn/invite?icode=i1hBPobA%2Bmtg8XS3qmwhTUjPr3uHog9F4g5tjuOUqno%3D
# MiniMax邀请：https://platform.minimaxi.com/subscribe/coding-plan?code=2685TjN0NW&source=link

# Load configuration from .env file if it exists
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $scriptDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*)\s*=\s*(.*?)\s*$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim() -replace "`r",""
            # Remove surrounding quotes if present
            if ($value -match '^["''](.*)["'']$') {
                $value = $matches[1]
            }
            Set-Item -Path "env:$key" -Value $value
        }
    }
}

# Default values (will be overridden by .env if set)
$DEBUG_MODE = if ($env:DEBUG_MODE -eq "true") { $true } else { $false }
$BASE_URL = if ($env:BASE_URL) { $env:BASE_URL } else { "https://api.minimaxi.com/v1" }
$LLM_MODEL = if ($env:LLM_MODEL) { $env:LLM_MODEL } else { "MiniMax-M2.5" }
$apiKey = if ($env:API_KEY) { $env:API_KEY.Trim() } else { $env:MINIMAX_API_KEY.Trim() }

# Check API key before proceeding
if (-not $apiKey) {
    Write-Host "Error: API key is not configured." -ForegroundColor Red
    Write-Host "Please set API_KEY or MINIMAX_API_KEY in .env file or environment variables." -ForegroundColor Yellow
    exit 1
}

$gitCmdPath = "C:\Program Files\Git\cmd"
$gitCmdPathAlt = "C:\Program Files (x86)\Git\cmd"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (Test-Path $gitCmdPath) {
        $env:PATH = "$gitCmdPath;$env:PATH"
    } elseif (Test-Path $gitCmdPathAlt) {
        $env:PATH = "$gitCmdPathAlt;$env:PATH"
    }
}
$LLM_PROMPT_TEMPLATE = @"
Generate a commit message for the Git diff below.

OUTPUT FORMAT (exactly follow this format):
Summary: One-sentence summary
    - [Add] filename
    - [Modify] filename: changes
    - [Delete] filename

IMPORTANT:
- Do NOT include any explanation, reasoning, or analysis
- Do NOT use thinking tags like <thinking>, （, （
- Do NOT include "Change content:" or diff details
- Output ONLY the commit message, nothing else
- Use present continuous tense

Git Diff:
{0}
"@

# Function to check and clear any existing Git processes and lock files
function Clear-GitProcesses {
    try {
        # Check for running git processes
        Write-Host "Checking for existing Git processes..." -ForegroundColor Cyan
        $gitProcesses = Get-Process -Name "git" -ErrorAction SilentlyContinue
        
        if ($gitProcesses -and $gitProcesses.Count -gt 0) {
            Write-Host "Found $($gitProcesses.Count) running Git process(es). Attempting to clear..." -ForegroundColor Yellow
            
            # Try to gracefully stop git processes
            $gitProcesses | ForEach-Object {
                Write-Host "  Stopping Git process (PID: $($_.Id))..." -ForegroundColor Yellow
                $_ | Stop-Process -Force
            }
            
            # Wait a moment to ensure processes are terminated
            Start-Sleep -Seconds 2
            
            # Check if any Git processes still exist
            $remainingGitProcesses = Get-Process -Name "git" -ErrorAction SilentlyContinue
            if ($remainingGitProcesses -and $remainingGitProcesses.Count -gt 0) {
                Write-Host "Warning: Could not stop all Git processes. Some operations might fail." -ForegroundColor Red
            } else {
                Write-Host "All Git processes cleared successfully." -ForegroundColor Green
            }
        } else {
            Write-Host "No existing Git processes detected." -ForegroundColor Green
        }
        
        # Check and remove git lock files
        Write-Host "Checking for Git lock files..." -ForegroundColor Cyan
        $gitDir = ".git"
        $lockFiles = @()
        
        # Index lock file
        $indexLock = Join-Path -Path $gitDir -ChildPath "index.lock"
        if (Test-Path $indexLock) {
            $lockFiles += $indexLock
        }
        
        # Check for other possible lock files in .git directory
        if (Test-Path $gitDir) {
            $otherLockFiles = Get-ChildItem -Path $gitDir -Recurse -Filter "*.lock" | Select-Object -ExpandProperty FullName
            $lockFiles += $otherLockFiles
        }
        
        # Remove lock files if found
        if ($lockFiles.Count -gt 0) {
            Write-Host "Found $($lockFiles.Count) Git lock file(s). Removing..." -ForegroundColor Yellow
            
            foreach ($lockFile in $lockFiles) {
                try {
                    Write-Host "  Removing lock file: $lockFile" -ForegroundColor Yellow
                    Remove-Item -Path $lockFile -Force
                    
                    if (Test-Path $lockFile) {
                        Write-Host "  Failed to remove lock file: $lockFile" -ForegroundColor Red
                    } else {
                        Write-Host "  Successfully removed lock file: $lockFile" -ForegroundColor Green
                    }
                } catch {
                    $errorMsg = $_.Exception.Message
                    Write-Host "  Error removing lock file $lockFile - $errorMsg" -ForegroundColor Red
                }
            }
        } else {
            Write-Host "No Git lock files detected." -ForegroundColor Green
        }
    } catch {
        $errorMsg = $_.Exception.Message
        Write-Host "Error checking/clearing Git processes and lock files - $errorMsg" -ForegroundColor Red
    }
}

# Function to get git diff in a structured format
function Get-GitChanges {
    $stagedFiles = git diff --staged --name-status
    if (-not $stagedFiles) {
        return $null
    }    
    $changes = @{
        "added" = @()
        "modified" = @()
        "deleted" = @()
    }    
    $stagedFiles | ForEach-Object {
        $status, $file = $_ -split "\s+"
        switch ($status) {
            "A" { $changes["added"] += $file }
            "M" { $changes["modified"] += $file }
            "D" { $changes["deleted"] += $file }
        }
    }    
    return $changes
}

# Function to get detailed diff content
function Get-DetailedDiff {
    try {
        $diff = git diff --staged --patch
        if (-not $diff) {
            return "No changes detected"
        }
        # Convert diff output to string and escape special characters
        return [string]::Join("
", $diff)
    }
    catch {
        Write-Host "Error getting Git diff content: $($_.Exception.Message)" -ForegroundColor Yellow
        return "Error getting diff content"
    }
}

# Function to generate commit message using Ollama
function Get-LLMCommitMessage {
    param (
        [Parameter(Mandatory=$true)]
        [string]$diffContent
    )    
    $prompt = $LLM_PROMPT_TEMPLATE -f $diffContent    
    $maxRetries = 3
    $retryCount = 0    
    while ($retryCount -lt $maxRetries) {
        try {
            Write-Host "Model in use: $LLM_MODEL" -ForegroundColor Cyan
            if (-not $apiKey) {
                Write-Host "Error: Environment variable API_KEY is not set." -ForegroundColor Red
                return $null
            }
            $headers = @{
                "Authorization" = "Bearer $apiKey"
                "Content-Type" = "application/json"
            }
            $body = @{
                model = $LLM_MODEL
                messages = @(
                    @{role = "user"; content = $prompt}
                )
                top_p = 0.7
                temperature = 0.9
            } | ConvertTo-Json -Depth 5 # Ensure nested structures are correctly converted
            $apiUrl = "$BASE_URL/chat/completions"
            $response = Invoke-RestMethod -Uri $apiUrl -Method Post -Headers $headers -Body $body -ContentType "application/json"
            if ($response -and $response.choices -and $response.choices.count -gt 0) {
                # Extract response content
                $commitMessage = $response.choices[0].message.content

                # Remove AI reasoning tags (<think> and</think>)
                $commitMessage = $commitMessage -replace '(?s)<thinking>.*?</thinking>', ''
                $commitMessage = $commitMessage -replace '(?s)<think>.*?</think>', ''
                $commitMessage = $commitMessage -replace '(?s)<analysis>.*?</analysis>', ''
                $commitMessage = $commitMessage -replace '(?s)<reasoning>.*?</reasoning>', ''

                # Maintain line breaks and clean up excess whitespace
                # 修正正则表达式：仅删除行首空白字符（空格/制表符）
                $cleanResponse = $commitMessage.Trim() -replace '(?m)^[ \t]+', ''
                # Remove possible prefixes (adjust as needed)
                # 精确处理commit message前缀（严格匹配格式）
                $cleanResponse = $cleanResponse -replace '(?im)^commit message:\s*', ''
                # Extract and format summary content (adjust as needed)
                # Improved regex to handle case-insensitivity and find the end of the summary line more reliably
                # 精确匹配并保留原始Summary格式
                if ($cleanResponse -match '(?m)^Summary:\s*(.*?)(\r?\n|$)') {
                    $summary = $matches[1].Trim()
                    # 直接使用原始匹配内容保持格式
                    $cleanResponse = $cleanResponse -replace '(?m)^Summary:\s*.*?(\r?\n|$)', ''
                    $cleanResponse = "Summary: $summary`r`n" + $cleanResponse.TrimStart()
                }
                # Ensure list items start on new lines, handling potential leading spaces
                $cleanResponse = $cleanResponse -replace '(?<!\r?\n)\s*-\s*\[', "`r`n- ["
                # If there are blank lines, delete them
                $cleanResponse = $cleanResponse -replace '(?m)^\s*$\r?\n', ''
                # Ensure proper UTF-8 encoding without HTML escaping (PowerShell handles this)
                # $cleanResponse = $cleanResponse # No change needed
                # Write-Host $cleanResponse -ForegroundColor Green # Debugging line
                return $cleanResponse
            }
            throw "No valid response choices from LLM"
        }
        catch {
            $retryCount++
            if ($retryCount -lt $maxRetries) {
                Write-Host "LLM request failed, retrying ($retryCount/$maxRetries)... Error: $($_.Exception.Message)" -ForegroundColor Yellow # Include error message
                Start-Sleep -Seconds (2 * $retryCount) # Exponential backoff
            }
            else {
                Write-Host "Failed to generate LLM commit message after $maxRetries retries: $($_.Exception.Message)" -ForegroundColor Red # Changed color to Red
                return $null
            }
        }
    }
    return $null
}

# Main script execution
try {
    # Clear any existing Git processes and lock files before proceeding
    Clear-GitProcesses
    
    # Auto stage all changes
    Write-Host "`nAutomatically staging all changes..." -ForegroundColor Cyan
    git add -A
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stage files"
    }
    Write-Host "Files staged successfully" -ForegroundColor Green

    # Check staged changes
    Write-Host "`nStarting to check Git changes..." -ForegroundColor Cyan
    $changes = Get-GitChanges
    if (-not $changes) {
        Write-Host "No changes detected, nothing to commit." -ForegroundColor Green
        Write-Host "`nAuto Git commit and push completed with no changes!" -ForegroundColor Green
        # 不退出，返回成功信息而非直接退出
        return @{
            success = $true
            message = "No changes to commit, working tree clean"
        }
    }
    $diffContent = Get-DetailedDiff    
    # Generate commit message using LLM
    Write-Host "`nUsing LLM to analyze changes and generate a commit message..." -ForegroundColor Cyan
    $commitMessage = Get-LLMCommitMessage -diffContent $diffContent    
    if (-not $commitMessage) {
        $currentDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $commitMessage = "LLM invalid, auto backup: $currentDate"
        Write-Host "Using default commit message" -ForegroundColor Yellow
    }    
    Write-Host "`nCommit message:" -ForegroundColor Cyan
    Write-Host $commitMessage -ForegroundColor Green    
    if ($DEBUG_MODE) {
        Write-Host "`n[Debug mode] Skipping commit and push operations" -ForegroundColor Yellow
        # Pause
    } else {
        # Perform commit operation
        Write-Host "`nCreating a commit..." -ForegroundColor Cyan
        # 将提交消息写入临时文件，避免命令行参数引用问题
        $commitMsgFile = [System.IO.Path]::GetTempFileName()
        $commitMessage | Out-File -FilePath $commitMsgFile -Encoding utf8
        git commit -F $commitMsgFile > $null
        Remove-Item $commitMsgFile -Force
        Write-Host "Commit created successfully" -ForegroundColor Green
        Write-Host "`nPushing all branches to remote..." -ForegroundColor Cyan
        git push --all origin > $null 2>&1  #do not show messages
        Write-Host "Branches pushed successfully" -ForegroundColor Green
        # Pause
    }
    
    Write-Host "`nAuto Git commit and push completed!" -ForegroundColor Green
    Write-Output '{"success":true,"message":"Auto Git commit and push completed!"}'
}
catch {
    Write-Host "`nError: $_" -ForegroundColor Red
    Write-Host "Auto Git commit and push failed" -ForegroundColor Red
    Write-Output ('{"success":false,"message":"Auto Git commit and push failed: ' + $_.ToString().Replace('"', '\"') + '"}')
}