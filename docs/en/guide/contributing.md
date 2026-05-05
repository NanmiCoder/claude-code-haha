# Contributing and Local Quality Gates

This guide explains how to install, develop, test, and run the local quality gates before opening a PR. The goal is to help maintainers and contributors answer one question before review: did this change break the core Coding Agent workflow?

## Setup

Install root dependencies with Bun:

```bash
bun install
```

If your change touches `adapters/`, or if you run `check:adapters`, install adapter dependencies:

```bash
cd adapters
bun install
```

Do not commit local artifacts such as `artifacts/quality-runs/` or `node_modules/`.

## Required PR Gate

Before opening a normal PR, run:

```bash
bun run quality:pr
```

This gate does not call real models, so every contributor can run it locally. It writes reports to:

```text
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/report.json
```

Include the commands you ran and the report summary in your PR description.

## Area-Specific Checks

Run the checks that match the files you changed:

```bash
bun run check:server      # Server API, WebSocket, providers, sessions, and related tests
bun run check:adapters    # IM adapter tests
bun run check:docs        # Docs build, using npm ci + docs:build
```

Focused tests are fine while developing, but run `bun run quality:pr` before sending the PR.

## Live Model Baseline

`quality:baseline` runs real Coding Agent tasks: it starts the local server, creates isolated fixtures, asks a model through chat to fix code, runs tests, and saves transcripts, diffs, verification logs, and a report.

The default baseline command does not call real models:

```bash
bun run quality:baseline
```

To actually call models, pass `--allow-live` and choose a local provider.

First list your local providers and copyable selectors:

```bash
bun run quality:providers
```

Example output:

```text
Saved providers:
  MiniMax
    selector: minimax
    main: MiniMax-M2.7-highspeed
      --provider-model minimax:main:minimax-main
```

Copy one of the listed values:

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

You can run multiple models in one pass:

```bash
bun run quality:gate --mode baseline --allow-live \
  --provider-model codingplan:main:codingplan-main \
  --provider-model minimax:main:minimax-main
```

Provider selectors come from the providers saved in your local configuration. Contributors do not need the maintainer's provider UUIDs or vendor accounts. They can add their own provider locally, run `bun run quality:providers`, and choose their own model.

## When To Run The Baseline

Run the live baseline for changes touching:

- Session resume, WebSocket, or the CLI bridge
- Provider, model, or runtime selection
- Permissions, tool calls, file edits, and task execution
- Computer Use, Skills, or MCP
- Release preparation or broad cross-module refactors

If you do not have model access, still run `bun run quality:pr` and state in the PR why the live baseline was not run.

## Release Gate

Before a release, run release mode:

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

Release mode composes PR checks, baseline catalog validation, and live baseline cases. Reports are written to `artifacts/quality-runs/<timestamp>/`.

## PR Workflow

1. Create a product branch such as `fix/session-reconnect` or `feat/provider-quality-gate`.
2. Install dependencies and make the change.
3. Add tests for behavior changes.
4. Run focused checks for the affected area.
5. Run `bun run quality:pr`.
6. Run the live baseline for high-risk changes.
7. In the PR description, include user impact, verification commands, report summary, and known risks.

## FAQ

### Can I run checks without a provider?

Yes. Run the normal PR gate:

```bash
bun run quality:pr
```

Only the live baseline needs a real model. Configure your provider, then run:

```bash
bun run quality:providers
```

### What if provider selectors conflict?

If two provider names produce the same selector, `quality:providers` falls back to the provider ID. Copy the `--provider-model ...` value it prints.

### What if a model ID contains a colon?

Prefer role selectors:

```bash
--provider-model custom:haiku:custom-haiku
```

The runner resolves `haiku` to the real model ID from your local provider configuration.
