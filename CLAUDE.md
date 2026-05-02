# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

A Node.js + Express dashboard that visualizes GitHub Copilot Enterprise per-user Premium Request usage. Provides user rankings, cost estimation, Team management, Cost Center operations, analytics, and monthly billing.

## Key Commands

```bash
npm start              # Start production server (port 3000 by default)
npm run dev            # Dev mode with file-watch auto-restart (node --watch)
npm test               # Run all vitest unit tests
npm run test:watch     # Vitest watch mode
./scripts/preflight-check.sh    # Pre-flight checks (Shell)
node ./scripts/preflight-check.js  # Pre-flight checks (Node)
```

## Architecture

**Layered modular architecture** — `server.js` is a ~100-line entry that creates singletons, mounts route modules, and handles graceful shutdown.

```
server.js              Entry point — singletons, middleware, route mounting, shutdown
routes/
  usage.js             Usage data refresh, query, ranking (daily/range/default modes)
  billing.js           Enterprise billing summary, model usage ranking
  teams.js             Enterprise Teams list & members
  costcenter.js        Cost Center CRUD + batch add users from teams
  analytics.js         Trend data, top users, daily summary, team view
  user-mapping.js      Upload/reload user mapping (Excel → JSON)
  bill.js              Monthly team billing + Excel export
  seats.js             Seats data loader (shared module, not a standalone router)
lib/
  github-api.js        GitHub API client — LRU cache, ETag, concurrency queue, retry/backoff, single-flight
  usage-store.js       SQLite layer — better-sqlite3, prepared statements, dynamic TTL, monthly bill storage
  scheduler.js         Auto-refresh scheduler — setTimeout-based, runs at configurable times
  user-mapping.js      User mapping service — fs.watch + debounce hot-reload
  billing-config.js    Pricing config (Business $19/300req, Enterprise $39/1000req, $0.04 overage)
  date-utils.js        Date helpers
  helpers.js           Shared utilities
  logger.js            pino structured logger (dev=pretty, prod=JSON)
public/
  index.html / script.js     Main page (usage ranking, sorting, modals, pagination)
  costcenter.html / costcenter.js  Cost Center management
  analytics.html / analytics.js  Analytics page (Chart.js trends, top users, team view)
  billpage.html / billpage.js  Monthly team billing
  user.html / user.js        User mapping management
  common.js            Frontend shared module (CopilotDashboard IIFE namespace)
  styles.css           Global styles
```

**Dependency injection pattern:** All route modules receive a `deps` object `{ usageStore, teamCache, userMappingService }` via a factory function export. `server.js` creates the singletons and injects them.

**Three-layer cache:**
1. **Memory** (5-min LRU + in-flight dedup) → 2. **SQLite** (dynamic TTL: 1h for recent 3 days, 90d for older) → 3. **GitHub API** (with ETag conditional requests)

## Environment Variables

Required: `GITHUB_TOKEN`, `ENTERPRISE_SLUG`

Key optional: `PORT` (default 3000), `PRODUCT` (default "Copilot"), `INCLUDED_QUOTA` (default 300), `CACHE_TTL` (default 300s), `GITHUB_MAX_CONCURRENT` (default 3), `SCHED_DISABLED`, `SCHED_DAILY_TIMES` (default "03:00,12:00").

See README.md for full list.

## Development Conventions

- **No TypeScript** — pure CommonJS (`require`/`module.exports`).
- **No frontend framework** — vanilla JS + Chart.js, IIFE-wrapped to avoid globals.
- **DI over singletons in modules** — routes accept deps via factory, don't import singletons directly.
- **Tests** — vitest, covering pure-function modules (`date-utils`, `billing-config`, `helpers`). Route/integration tests not yet present.
- **Logging** — use `logger` from `lib/logger.js` (pino). Default level: debug in dev, info in prod.
- **UTC dates** — always use `getUTCFullYear()` / `getUTCMonth()` / `getUTCDate()` for date calculations. Local-time methods cause off-by-one errors at month boundaries in non-UTC timezones.
- **README changelog** — new features/fixes should be documented as a version entry in README.md.

## Pages / Routes

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/` | Main usage ranking, sorting, pagination |
| Cost Center | `/costcenter` | Cost Center management |
| Analytics | `/analytics` | Trends, Top Users, Team View tabs |
| Billing | `/billpage` | Monthly team billing (hidden entry, URL only) |
| User Mapping | `/user` | Upload Excel mapping, view member status |

All API routes prefixed with `/api/`. See README.md "新增 API 端点" section for full endpoint list.

## Testing

Unit tests in `test/` cover pure utility modules only. Run with `npm test`. No integration or route-level tests exist yet. When adding new pure functions, add corresponding tests in `test/`.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
