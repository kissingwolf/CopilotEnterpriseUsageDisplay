# CONTEXT.md — Domain Glossary

This file defines the domain language of this project. When naming concepts in issues, refactors, or tests, use the terms defined here.

## Core Concepts

| Term | Definition |
|------|------------|
| **Enterprise** | A GitHub Enterprise organization, identified by its `slug` (e.g. `YourEnterprise-slug`). All API calls are scoped to this slug. |
| **Premium Request** | A Copilot AI request that counts against a user's monthly quota. The unit of measurement for usage tracking. |
| **Seat** | A Copilot-assigned user in the Enterprise. Each seat has a `login` (GitHub username), optional `adName` (AD display name), Team membership, and plan type (`business` or `enterprise`). |
| **Cycle / Period** | A monthly billing cycle. "本周期" refers to the current calendar month's aggregated usage for a user. |
| **Included Quota** | The number of Premium Requests included in a user's subscription per cycle (Business = 300, Enterprise = 1000). Controlled by `INCLUDED_QUOTA`. |
| **Overage** | Premium Requests exceeding the included quota. Charged at $0.04/request on top of the base subscription fee. |
| **Team** | An Enterprise-level team grouping (from `GET /enterprises/{enterprise}/teams`). Not to be confused with GitHub org teams. |
| **Cost Center** | A billing cost center that groups users, organizations, or repositories for charge attribution. Managed via the `/costcenter` page. |
| **User Mapping** | A mapping table (`data/user_mapping.json`) that links GitHub usernames (`Github-name`) to AD display names (`AD-name`) and emails. Uploaded via Excel on the `/user` page. |
| **AD Name** | The Active Directory display name for a user, shown in preference to `login` wherever user mapping exists. Sometimes called "custom name". |
| **Daily Usage** | Raw per-user Premium Request counts for a given date, stored in SQLite `daily_usage` table. |
| **Monthly Bill** | Computed per-Team monthly billing data (subscription fee + overage), stored in SQLite `monthly_bill` table. |
| **Data Freshness** | The recency state of cached data: fresh (recently refreshed), stale (within TTL), or expired (past TTL, background refresh in progress). |

## Architecture Terms

| Term | Definition |
|------|------------|
| **Three-Layer Cache** | Memory (5-min LRU) → SQLite (dynamic TTL) → GitHub API. The foundational caching architecture. |
| **Single-Flight** | In-flight request deduplication: concurrent requests for the same resource share a single Promise. Prevents duplicate GitHub API calls from multiple browser tabs. |
| **Dynamic TTL** | SQLite cache TTL that varies by data age: 1 hour for dates within the last 3 days, 90 days for older dates. Protects against GitHub's 24–48h billing data delay. |
| **Per-User Fallback** | When the GitHub billing API returns aggregate-only data, the system falls back to per-user API calls to get individual user breakdowns. |
| **DI (Dependency Injection)** | All route modules receive a `deps` object `{ usageStore, teamCache, userMappingService }` via factory function. No module imports singletons directly. |
| **SWR** | Stale-While-Revalidate: frontend cache strategy that shows cached data immediately while silently fetching fresh data in the background. |

## Plans & Pricing

| Plan | Monthly Quota | Base Price | Overage Rate |
|------|--------------|------------|--------------|
| Business | 300 requests | $19 | $0.04/request |
| Enterprise | 1000 requests | $39 | $0.04/request |

## Conventions

- **UTC dates everywhere**: All date operations use `getUTCFullYear()` / `getUTCMonth()` / `getUTCDate()`. Local-time methods cause off-by-one errors at month boundaries in non-UTC timezones.
- **No TypeScript**: Pure CommonJS (`require` / `module.exports`).
- **No frontend framework**: Vanilla JS + Chart.js, IIFE-wrapped to avoid globals.
- **AD name priority**: Wherever a user name is displayed, prefer `adName` (from user mapping), fall back to `login` (GitHub username).
- **README changelog**: New features/fixes must be documented as a version entry in README.md.
