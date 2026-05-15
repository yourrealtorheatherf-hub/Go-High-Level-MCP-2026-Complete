# GoHighLevel MCP Server

Model Context Protocol server for GoHighLevel. It exposes GHL API operations as MCP tools over stdio, Streamable HTTP, and legacy SSE.

## Current API Coverage

- Official GHL endpoints parsed: `576`
- Official endpoint coverage: `576 / 576`
- Generated official endpoint tools: `238`
- Local-only endpoint references tracked for review: `253`
- Daily GitHub Actions refresh opens a PR when the official GHL API docs change.

Coverage artifacts:

- `docs/GHL-API-COVERAGE-REPORT.md`
- `docs/GHL-LOCAL-ENDPOINT-CLASSIFICATION.md`
- `docs/ghl-api-coverage.json`

## Transports

- `npm run start:stdio` — stdio MCP server for desktop MCP clients.
- `npm run start:http` — Streamable HTTP server at `/mcp`.
- `npm run start:legacy` — legacy SSE server at `/sse`.

The HTTP server also exposes:

- `GET /health`
- `GET /capabilities`
- `GET /tools`
- `POST /execute`
- `POST /tools/call`

## Setup

```bash
npm install
cp .env.example .env
```

Set:

```bash
GHL_API_KEY=your_private_integration_api_key
GHL_LOCATION_ID=your_location_id
GHL_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
```

Build and run:

```bash
npm run build
npm run start:stdio
```

For HTTP:

```bash
npm run start:http
```

## MCP Client Config

Example stdio config:

```json
{
  "mcpServers": {
    "ghl": {
      "command": "node",
      "args": ["/absolute/path/to/Go-High-Level-MCP-2026-Complete/dist/server.js"],
      "env": {
        "GHL_API_KEY": "your_private_integration_api_key",
        "GHL_LOCATION_ID": "your_location_id",
        "GHL_BASE_URL": "https://services.leadconnectorhq.com",
        "GHL_API_VERSION": "2021-07-28"
      }
    }
  }
}
```

## Scripts

```bash
npm run build              # Compile server files to dist/
npm run lint               # Fast TypeScript syntax/transpile check
npm test                   # Jest tests
npm run scan:ghl-api       # Refresh official GHL API coverage and generated tools
npm run ci:ghl-api-drift   # Fail if generated API artifacts are stale
npm run smoke:ghl-live     # Optional read-only live checks when GHL env vars are set
```

## Daily API Refresh

`.github/workflows/ghl-api-drift.yml` runs daily. It:

1. Pulls the latest official `GoHighLevel/highlevel-api-docs` snapshot.
2. Regenerates coverage docs and generated official endpoint tools.
3. Opens a PR if any generated artifacts changed.

PRs and pushes also run drift checks so stale generated files do not silently land.

## Project Layout

```text
src/
  clients/       GHL API clients
  tools/         MCP tool modules
  types/         shared TypeScript types
  main.ts        Streamable HTTP MCP server
  server.ts      stdio MCP server
  http-server.ts legacy SSE MCP server
scripts/         API scanner, generator, build, smoke test
docs/            generated API coverage reports
tests/           Jest tests
```

## Notes

- `src/tools/official-spec-tools.ts` and `src/tools/official-spec-endpoints.json` are generated. Do not edit them by hand.
- Run `npm run scan:ghl-api` after GHL API docs change.
- The live smoke test is opt-in and only runs when `GHL_API_KEY` and `GHL_LOCATION_ID` are present.
