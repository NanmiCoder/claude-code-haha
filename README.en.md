# Claude Code Haha

<p align="center">
  <img src="docs/images/logo-horizontal.png" alt="Claude Code Haha" width="480">
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/NanmiCoder/cc-haha?style=social)](https://github.com/NanmiCoder/cc-haha/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/NanmiCoder/cc-haha?style=social)](https://github.com/NanmiCoder/cc-haha/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/pulls)
[![License](https://img.shields.io/github/license/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/blob/main/LICENSE)
[![中文](https://img.shields.io/badge/🇨🇳_中文-Available-green)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-当前-blue)](README.en.md)
[![Docs](https://img.shields.io/badge/📖_Documentation-Visit-D97757)](https://claudecode-haha.relakkesyang.org)

</div>

A **locally runnable version** repaired from the leaked Claude Code source, with support for any Anthropic-compatible API endpoint (MiniMax, OpenRouter, etc.). Beyond the full TUI, we've also completed Computer Use (macOS / Windows) and enabled **full remote control** via Telegram / Feishu.

<p align="center">
  <a href="#features">Features</a> · <a href="#architecture-overview">Architecture</a> · <a href="#quick-start">Quick Start</a> · <a href="docs/en/guide/env-vars.md">Env Vars</a> · <a href="docs/en/guide/faq.md">FAQ</a> · <a href="docs/en/guide/global-usage.md">Global Usage</a> · <a href="#more-documentation">More Docs</a>
</p>

---

## Features

- Full Ink TUI experience (matching the official Claude Code interface)
- `--print` headless mode for scripts and CI
- MCP server, plugin, and Skills support
- Custom API endpoint and model support ([Third-Party Models Guide](docs/en/guide/third-party-models.md))
- **Memory System** (cross-session persistent memory) — [Usage Guide](docs/memory/01-usage-guide.md)
- **Multi-Agent System** (agent orchestration, parallel tasks, Teams collaboration) — [Usage Guide](docs/agent/01-usage-guide.md) | [Implementation](docs/agent/02-implementation.md)
- **Skills System** (extensible capability plugins, custom workflows) — [Usage Guide](docs/skills/01-usage-guide.md) | [Implementation](docs/skills/02-implementation.md)
- **Channel System** (remote Agent control via Telegram/Feishu/Discord IM platforms) — [Architecture](docs/en/channel/01-channel-system.md)
- **Computer Use desktop control** — [Guide](docs/en/features/computer-use.md) | [Architecture](docs/en/features/computer-use-architecture.md)
- Fallback Recovery CLI mode (`CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha`)

---

## Architecture Overview

<table>
  <tr>
    <td align="center" width="25%"><img src="docs/images/01-overall-architecture.png" alt="Overall architecture"><br><b>Overall architecture</b></td>
    <td align="center" width="25%"><img src="docs/images/02-request-lifecycle.png" alt="Request lifecycle"><br><b>Request lifecycle</b></td>
    <td align="center" width="25%"><img src="docs/images/03-tool-system.png" alt="Tool system"><br><b>Tool system</b></td>
    <td align="center" width="25%"><img src="docs/images/04-multi-agent.png" alt="Multi-agent architecture"><br><b>Multi-agent architecture</b></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="docs/images/05-terminal-ui.png" alt="Terminal UI"><br><b>Terminal UI</b></td>
    <td align="center" width="25%"><img src="docs/images/06-permission-security.png" alt="Permissions and security"><br><b>Permissions and security</b></td>
    <td align="center" width="25%"><img src="docs/images/07-services-layer.png" alt="Services layer"><br><b>Services layer</b></td>
    <td align="center" width="25%"><img src="docs/images/08-state-data-flow.png" alt="State and data flow"><br><b>State and data flow</b></td>
  </tr>
</table>

## Quick Start

### 1. Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS (Homebrew)
brew install bun

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

> On minimal Linux images, if you see `unzip is required`, run `apt update && apt install -y unzip` first.

### 2. Install Dependencies and Configure

```bash
bun install
cp .env.example .env
# Edit .env with your API key — see docs/en/guide/env-vars.md for details
```

### 3. Start

#### macOS / Linux

```bash
./bin/claude-haha                          # Interactive TUI mode
./bin/claude-haha -p "your prompt here"    # Headless mode
./bin/claude-haha --help                   # Show all options
```

#### Windows

> **Prerequisite**: [Git for Windows](https://git-scm.com/download/win) must be installed.

```powershell
# PowerShell / cmd — call Bun directly
bun --env-file=.env ./src/entrypoints/cli.tsx

# Or run inside Git Bash
./bin/claude-haha
```

### 4. Global Usage (Optional)

Add `bin/` to your PATH to run from any directory. See [Global Usage Guide](docs/en/guide/global-usage.md):

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```


## Sponsorship & Partnership

This project is maintained in the author's spare time. Corporate or individual sponsorships are welcome to support ongoing development. Custom features, integrations, and business partnerships are also open for discussion.

<table>
  <thead>
    <tr>
      <th width="220">Sponsor</th>
      <th align="left">Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" valign="middle">
        <a href="https://jiekou.ai/referral?invited_code=OBNU3K">
          <img src="docs/images/sponsors/jiekou-logo.svg" width="72" alt="JieKou AI"><br>
          <strong>接口AI</strong>
        </a>
      </td>
      <td valign="middle">
        Thanks to <a href="https://jiekou.ai/referral?invited_code=OBNU3K">JieKou AI</a> for sponsoring this project. JieKou AI provides official model resources with stable, high-performance API access. Subscription bundles are priced at 20% off the official rate; new users who register through <a href="https://jiekou.ai/referral?invited_code=OBNU3K">this link</a> and bind GitHub can claim a $3 coupon.
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">
          <img src="docs/images/sponsors/shengsuanyun-logo.svg" width="180" alt="ShengSuanYun">
        </a>
      </td>
      <td valign="middle">
        Thanks to <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">ShengSuanYun</a> for sponsoring this project. ShengSuanYun is an industrial-grade AI task parallel execution platform for AI Native Teams, aggregating Claude, ChatGPT, Gemini, and other LLM, image, and video model capacity through direct, non-reverse-engineered access. Its platform SLA reaches 99.7%, with <a href="https://watch.shengsuanyun.com/status/shengsuanyun">service status</a> available online. It also supports dedicated enterprise gateways, cost and permission controls, smart routing, security protection, BYOK, usage-based billing, upcoming tokens plans, and invoicing. New users registering through <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">this link</a> can receive 10 yuan in model credits plus a 10% first top-up bonus.
      </td>
    </tr>
  </tbody>
</table>

📧 **Contact**: relakkes@gmail.com

---

## ☕ Buy Me a Coffee

If this project helps you, consider buying me a coffee — every bit of support keeps this project going ❤️

<table>
<tr>
<td align="center" width="33%">
<img src="docs/images/donate/wechat_pay.jpeg" width="250" alt="WeChat Pay"><br>
<b>WeChat Pay</b>
</td>
<td align="center" width="33%">
<img src="docs/images/donate/zfb_pay.png" width="250" alt="Alipay"><br>
<b>Alipay</b>
</td>
<td align="center" width="33%">
<a href="https://buymeacoffee.com/relakkes" target="_blank">
<img src="docs/images/donate/bmc_button.png" width="250" alt="Buy Me a Coffee">
</a><br>
<b>Buy Me a Coffee</b>
</td>
</tr>
</table>

---

## Tech Stack

| Category | Technology |
|------|------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| API | Anthropic SDK |
| Protocols | MCP, LSP |

---

## More Documentation

| Document | Description |
|------|------|
| [Environment Variables](docs/en/guide/env-vars.md) | Full env var reference and configuration methods |
| [Third-Party Models](docs/en/guide/third-party-models.md) | Using OpenAI / DeepSeek / Ollama and other non-Anthropic models |
| [Contributing](docs/en/guide/contributing.md) | Local tests, live model baselines, PR gates, and release gates |
| [Memory System](docs/memory/01-usage-guide.md) | Cross-session persistent memory usage and implementation |
| [Multi-Agent System](docs/agent/01-usage-guide.md) | Agent orchestration, parallel tasks and Teams collaboration |
| [Skills System](docs/skills/01-usage-guide.md) | Extensible capability plugins, custom workflows and conditional activation |
| [Channel System](docs/en/channel/01-channel-system.md) | Remote Agent control via Telegram/Feishu/Discord IM platforms |
| [Computer Use](docs/en/features/computer-use.md) | Desktop control (screenshots, mouse, keyboard) — [Architecture](docs/en/features/computer-use-architecture.md) |
| [Global Usage](docs/en/guide/global-usage.md) | Run claude-haha from any directory |
| [FAQ](docs/en/guide/faq.md) | Common error troubleshooting |
| [Source Fixes](docs/en/reference/fixes.md) | Fixes compared with the original leaked source |
| [Project Structure](docs/en/reference/project-structure.md) | Code directory structure |

---

## Thanks

Thanks to the following open-source projects and community practices for reference and inspiration:

- [React](https://github.com/facebook/react): frontend engineering and component-based UI ecosystem.
- [cc-switch](https://github.com/farion1231/cc-switch): reference for model provider configuration.

---

## ⭐ Star History

If this project helps you, please support it with a ⭐ Star so more people can discover Claude Code Haha.

<a href="https://www.star-history.com/#NanmiCoder/cc-haha&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date" />
  </picture>
</a>

---

## Disclaimer

This repository is based on the Claude Code source leaked from the Anthropic npm registry on 2026-03-31. All original source code copyrights belong to [Anthropic](https://www.anthropic.com). It is provided for learning and research purposes only.
