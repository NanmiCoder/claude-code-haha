# Web SaaS Quickstart

## Run the server

```bash
bun install
CC_HAHA_WORKSPACES_ROOT="$(pwd)/workspaces" SERVER_PORT=3456 bun run src/server/index.ts
```

The server creates `workspaces/` if it does not exist. Every session lives in
`workspaces/<workspaceName>/`. If `workspaceName` is omitted in
`POST /api/sessions`, the server uses the `sessionId` itself as the directory
name. Multiple sessions may share the same `workspaceName`.

## Build and serve the web frontend

```bash
cd web
bun install
bun run build
```

The build output lands in `web/dist/`, which is served by the existing Bun
process (see `src/server/staticH5.ts`).

For a hot-reload dev loop run `bun run dev` instead and connect the
browser to `http://127.0.0.1:5173` — the Vite dev server proxies `/api`
and `/ws` to the Bun server on port 3456.

## What is intentionally disabled in this profile

- Computer Use
- H5 access tokens / OAuth callbacks
- Tauri-specific UI (window controls, native notifications, updater)
- Doctor self-repair flows (the diagnostics endpoints stay available)
- All tool/file/agent permission prompts: actions inside the workspace
  root are pre-authorised; anything that would touch a path outside the
  workspace root is denied at the API boundary.
