# Development Workflow

This document describes the local development, QA, testing, and release workflow for TradeTrail (repository `trades-exporter`).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Env & Secrets Files](#env--secrets-files)
- [Branching Strategy](#branching-strategy)
- [Daily Development Workflow](#daily-development-workflow)
- [Scenario Environment](#scenario-environment)
- [Testing](#testing)
- [Deployment](#deployment)
- [Command Parameters & Runtime Flags](#command-parameters--runtime-flags)
- [Safety Features](#safety-features)
- [Common Workflows](#common-workflows)
- [Task Commands Reference](#task-commands-reference)
- [Known Gaps vs Reference Workflow](#known-gaps-vs-reference-workflow)
- [Port Reference](#port-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

```bash
# macOS
brew install go-task/tap/go-task  # Taskfile runner
brew install gh                   # GitHub CLI
brew install act                  # Local CI runner (optional)

# Verify
task --version && gh --version && docker --version
```

---

## Quick Start

```bash
git clone <repository-url>
cd trades-exporter
task install          # install Python + npm dependencies
task start:dev        # DB + backend (--reload) + frontend (vite)
```

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:8000>
- Swagger Docs: <http://localhost:8000/docs>

---

## Environment Overview

| Environment | Purpose | DB | Backend | Frontend |
|-------------|---------|----|---------|----------|
| **dev** | Local development, hot reload, VS Code debugging | localhost:5432 | localhost:8000 | localhost:5173 |
| **staging:local** | Containerized integration/QA stack | localhost:5433 | localhost:8001 | localhost:3001 |
| **scenario** | Isolated manual QA with seeded data | localhost:5435+ | localhost:8002+ | localhost:3002+ |
| **prod:local** | Local production-like stack from tagged images | localhost:5434 | localhost:8080 | localhost:3000 |

All environments are local Docker Compose stacks — there is no remote hosting. The workflow mirrors the salsa-events-calendar structure (dev-as-scenario, `<env>.local.env` config, per-component releases, deployment refs) without its Fly.io / Neon / Cloudflare parts.

**Prod data lives in `prod:local`** (DB `trades_db_prod`, volume `trades_prod_data`, port 5434). Dev (`trades_dev_data`) is for development only.

---

## Env & Secrets Files

Tasks load environment files in layers. Shared defaults come from `config/base.env`; environment-specific files override those values; secret files are gitignored.

| File | Committed | Loaded by |
|------|-----------|-----------|
| `config/base.env` | yes | all tasks; shared non-secret defaults |
| `scenarios/dev/config.env` | yes | `dev` tasks (dev is a scenario named `dev` with pinned ports) |
| `config/staging.local.env` | yes | `staging:local` tasks |
| `config/prod.local.env` | yes | `prod:local` tasks |
| `config/scenario.env` | yes | scenario tasks |
| `config/secrets.env` | no | shared local secrets |
| `config/secrets.dev.env` | no | dev-only secrets |
| `config/secrets.staging.local.env` | no | local staging secrets |
| `config/secrets.prod.local.env` | no | local prod secrets |
| `config/secrets.scenario.env` | no | scenario secrets |

Rule: local tasks resolve database settings from the layered config stack instead of duplicating shared values in every env file. For example, `POSTGRES_USER` and `POSTGRES_PASSWORD` live in `config/base.env`, while each environment file provides its database name and port.

---

## Branching Strategy

```text
main (production)
└── hotfix/*     -> PR directly to main

develop (integration)
├── feature/*    -> PR to develop
└── fix/*        -> PR to develop
```

| Type | Base | Command |
|------|------|---------|
| `feature/*` | develop | `task git:feature -- <name>` |
| `fix/*` | develop | `task git:fix -- <name>` |
| `hotfix/*` | main | `task git:hotfix -- <name>` |

See [Common Workflows](#common-workflows) for end-to-end journeys built on top of this branching model.

---

## Daily Development Workflow

### 1. Start Your Day

```bash
git checkout develop && git pull origin develop
task git:feature -- my-feature-name
```

### 2. Start Development Environment

```bash
task start:dev          # DB + backend (reload) + frontend
task start:dev:debug    # same + debugpy on port 5678
```

Browser control on `start:*` commands uses these parameters:

- `BROWSER=none|shared|isolated` (default `none` for `start:*`)
  - `none` starts servers only.
  - `shared` focuses an existing Chrome tab matching the URL, or opens one in the default Chrome profile.
  - `isolated` opens `COUNT` Chrome sessions, each with its own `--user-data-dir` under `/tmp/chrome-profiles`.
- `COUNT=N` opens multiple isolated sessions. Default: `1`.
- `RESET_BROWSER=1` wipes matching isolated profile dirs before launching.

```bash
task start:dev                                      # servers only
task start:dev BROWSER=shared                       # focus/open normal dev tab
task start:dev BROWSER=isolated                     # one isolated session
task start:dev BROWSER=isolated COUNT=3             # three isolated sessions
task start:staging:local BROWSER=isolated RESET_BROWSER=1 COUNT=1
SCENARIO=spinoff task start:scenario BROWSER=isolated COUNT=2
```

Isolated sessions are idempotent: re-running the same task focuses the existing session instead of duplicating it. Scenario stop tasks clean their own isolated browser profiles automatically. Pass `KEEP_BROWSER=1` to keep them open.

Backend runtime parameters:

- `LOG_LEVEL=<level>` defaults to `INFO` for local backend start tasks.
- `UVICORN_ACCESS_LOG_EXCLUDE_PATHS='<json-list>'` overrides the access-log exclusion list loaded from config.
- `DONT_RELOAD=true` disables uvicorn `--reload` for `task start:dev` and `task start:dev:debug`.
- `AUTO_START_DB=false` can be passed to backend-only tasks when you do not want the dev DB dependency to start automatically.

Examples:

```bash
LOG_LEVEL=DEBUG task start:dev
DONT_RELOAD=true task start:dev
AUTO_START_DB=false task start:dev:backend
UVICORN_ACCESS_LOG_EXCLUDE_PATHS='["/health"]' task start:dev
```

### 3. Attach VS Code Debugger

Press `F5` and select **Backend: Attach** or **Full Stack Debug**.

### 4. Run Tests

```bash
task test               # quick unit tests
task test:backend:unit  # backend only
task test:frontend:unit # frontend type check + build
```

### 5. Commit and Create PR

```bash
git add . && git commit -m "feat: my feature"
task git:pr             # push + open draft PR; target is auto-detected
```

### 6. End of Day

```bash
task stop:dev
```

---

## Scenario Environment

Isolated full stack with per-scenario seeded data. Use scenarios for manual QA, demos, and validating edge cases without touching dev or local staging.

### Scenario Folder Structure

```text
scenarios/<name>/
├── accounts.yaml        # optional extra accounts
├── assets.yaml          # optional extra assets
├── bundles.yaml         # optional bundle overrides
└── transactions.yaml    # scenario trades/transactions
```

Seeding is idempotent: assets upsert by symbol, accounts by name, and transactions by source identifiers. Scenario folders only need data specific to that test case.

### Lifecycle

```bash
task start:scenario                                      # default scenario; local code + Docker DB
SCENARIO=fr_tax task start:scenario                      # named scenario; own DB + ports
SCENARIO=spinoff task start:scenario BROWSER=isolated    # one isolated Chrome session
SCENARIO=spinoff task start:scenario BROWSER=isolated COUNT=2
SCENARIO=spinoff task start:scenario RESET=1             # tear down/recreate existing scenario first
SCENARIO=custom PORT_OFFSET=42 task start:scenario       # explicit port offset

# From a git ref (all-Docker)
task start:scenario:ref -- feature/my-branch
task start:scenario:ref BROWSER=isolated COUNT=2 -- feature/my-branch

# DB-only / backend-only variants (portable fixtures for automated tests, CI, Playwright)
SCENARIO=my_test task start:scenario:db RESET=1          # Docker DB only, migrated + seeded
SCENARIO=my_test task start:scenario:backend RESET=1     # Docker DB + backend (detached), no frontend
task stop:scenario SCENARIO=my_test --yes                # tear down either of the above

# DB operations
SCENARIO=fr_tax task db:seed:scenario
SCENARIO=fr_tax task db:seed:scenario WITH_DEFAULTS=1
SEED_DIR=/tmp/my-seed task db:seed:scenario SCENARIO=custom
SCENARIO=fr_tax task db:reset:scenario
DRY_RUN=1 SCENARIO=fr_tax task db:reset:scenario

# Logs and teardown
SCENARIO=fr_tax task logs:scenario
SCENARIO=fr_tax task stop:scenario
task stop:scenario:all
```

Scenario params:

| Param | Default | Applies to | Behavior |
|-------|---------|------------|----------|
| `SCENARIO=<name>` | `default` / empty | start, stop, logs, seed, reset, open | Selects a named scenario instance and deterministic port range. |
| `SEED_DIR=<path>` | auto-resolved from `scenarios/<SCENARIO>/` when present | `start:scenario`, `start:scenario:ref`, `db:seed:scenario`, `db:reset:scenario` | Explicit seed directory wins over auto-resolution. |
| `WITH_DEFAULTS=1` | `0` | `start:scenario`, `start:scenario:ref`, `db:seed:scenario` | Seed default data before scenario-specific files. |
| `RESET=1` | `0` | `start:scenario`, `start:scenario:ref`, `start:staging:local`, `start:prod:local` | Tear down the existing stack before starting. Prod local also requires `FORCE=1`. |
| `PORT_OFFSET=N` | hash of scenario name | scenario port resolver | Overrides deterministic hash ports; use this to resolve collisions. |

Ports are deterministic per scenario name. Run `task scenarios` to see all assignments, running status, and hash-collision warnings.

---

## Testing

```bash
task test               # unit tests (fast)
task test:backend:unit  # backend unit + API tests
task test:frontend:unit # frontend type check + build
task test:backend:int            # integration tests; requires integration DB setup
task test:backend:int:teardown    # setup -> test -> cleanup
task test:e2e                     # full-stack e2e (db + backend + frontend)
task test:backend           # all backend tests: unit + integration + e2e
task test:frontend          # all frontend tests: unit + e2e smoke
task test:all              # full suite: backend + frontend + full-stack e2e
```

```bash
task test:backend:e2e    # backend e2e tests; self-contained (provisions its own scenario DB)
task test:db:backup      # backup/restore/rollback/commit/copy/prune on throwaway scenario DBs (KEEP_SCENARIOS=1 skips teardown)
```

`task test:backend:int` runs the full `tests/integration/` suite in one go, including live-API tests marked `pytest.mark.network` (Yahoo, CoinGecko, Forex, Marketstack, Alpha Vantage, Coinbase, MEXC, Etherscan, etc.) — these self-skip via `pytest.skip(...)` when they hit a rate limit, missing API key, or transient network/auth error, rather than being excluded upfront. Pass `-m "integration and network"` (or similar) directly to pytest if you only want to exercise the live-API tests.

Integration and e2e tests each run against their own dedicated, self-provisioned scenario database — they're just named scenarios (`backend-integration-tests`, `backend-e2e-tests`), started via the same `start:scenario:db` mechanism as `task start:scenario`/`task start:scenario:backend` (Dockerized Postgres on a deterministic, name-hashed port; see `.taskfiles/start.yml`). `task test:backend:int` and `task test:backend:e2e` provision their scenario DB themselves as their first step — no separate CI or Taskfile setup step needed. Pass `SCENARIO=<name>` to run against a different scenario fixture instead (e.g. `SCENARIO=fr_tax task test:backend:int`); `WITH_DEFAULTS=1` (the default) layers the scenario's fixture on top of the default seed data (`settings.yaml`/`asset_map.yaml`), `WITH_DEFAULTS=0` uses only the scenario's own fixture. Use `task test:backend:int:teardown` to run setup, integration tests, and scenario teardown (`task stop:scenario`) in one flow.

---

## Deployment

### Staging Local (docker-compose)

Validates Docker images in a fully containerized stack.

`deploy:staging:local` deploys a develop commit from a SHA-pinned `.worktrees/ref-<sha>` checkout (it never touches your working tree). It only deploys components (`db`, `backend`, `frontend`) whose files changed since their last staging deploy, recorded in `refs/deploys/staging/<component>`.

```bash
task deploy:staging:local                        # changed components @ origin/develop
task deploy:staging:local -- <ref> --all         # all components @ a develop ref
task deploy:staging:local -- backend             # only backend
task deploy:staging:local -- --dry-run           # show the plan only
task deploy:staging:local:backend -- <ref>       # one component
task deploy:staging:local:ref -- feature/x       # quick full rebuild from ANY ref (not recorded)
task deploy:staging:local:cwd[:<component>]      # deploy the working directory
```

Staging deploys require green CI on the commit (needs `gh`); bypass with `--skip-ci-check` or `SKIP_CI_CHECK=1`.

The local staging stack uses `config/base.env`, `config/staging.local.env`, `config/secrets.env`, and `config/secrets.staging.local.env`.

### Production Local

Production-local is a local Docker Compose stack using versioned images from `main`.

Release tagging and production builds use detached `.worktrees/main` snapshots of `origin/main`; they do not require checking out `main` in your current working tree.

```bash
task git:release:prepare
task git:release:ready
task git:release:merge
task release:prod:backend  -- v1.2.0   # tag backend-v1.2.0 on main + deploy
task release:prod:frontend -- v1.2.0   # tag frontend-v1.2.0 + deploy
task release:prod:db       -- v1.2.0   # tag db-v1.2.0 + run migrations
task release:prod                      # interactive, prompts per component
task release:prod -- --fast            # changed components + suggested tags, one confirm
task release:prod -- --dry-run         # show the --fast plan only
```

Components (`db`, `backend`, `frontend`) release independently with annotated `<component>-vX.Y.Z` tags. Each `deploy:prod:local:<component> -- <tag>` shows `current → next (N commits ahead)` before prompting, refuses another component's tag, builds from a SHA-pinned `.worktrees/ref-<sha>` checkout via the `deploy:prod:local:cwd:<component>` primitive, tags the image as `trades-exporter-<component>:prod` (what `start:prod:local` runs) and `:<tag>`, health-checks the backend, and records the deployed SHA in the local ref `refs/deploys/prod/<component>`.

```bash
task deploy:prod:status                # released tag vs deployed SHA + drift
task deploy:prod:status:diff           # commits/files deployed vs origin/main
task deploy:prod:local:cwd[:<component>]   # deploy the working directory (not recorded)
```

The deploy gate checks CI is green for the tagged commit (needs `gh`); bypass with `SKIP_CI_CHECK=1`.

---

## Command Parameters & Runtime Flags

Task parameters are passed either as shell environment assignments before `task`, or as Task variables/CLI args after the task name:

```bash
DRY_RUN=1 task db:reset:dev
task start:dev BROWSER=isolated COUNT=2
task deploy:staging:local:ref -- feature/my-branch
task deploy:staging:local:ref REF=feature/my-branch
```

Common parameters:

| Param | Used by | Default | Notes |
|-------|---------|---------|-------|
| `DRY_RUN=1` | deploy, DB reset/copy/restore, backup prune, stop volume cleanup, build clean-all, tag cleanup | `0` | Prints planned actions without mutating state where implemented. |
| `RESET=1` | start dev DB, local staging/prod, scenarios | `0` | Recreates an existing stack/database before start. |
| `FORCE=1` | `start:prod:local RESET=1` | `0` | Required to reset prod-local during start. |
| `BROWSER=none|shared|isolated` | browser-aware start/open tasks | `none` for `start:*`, explicit mode for `open:*` | Controls browser launch mode. |
| `COUNT=N` | isolated browser start/open tasks | `1` | Number of isolated Chrome profiles to open. |
| `RESET_BROWSER=1` | isolated browser start/open tasks | `0` | Deletes matching isolated profiles first. |
| `KEEP_BROWSER=1` | scenario stop tasks | `0` | Keeps isolated scenario browser profiles open. |
| `SCENARIO=<name>` | scenario start/stop/log/open/DB tasks | default instance | Selects scenario instance and derived ports. |
| `PORT_OFFSET=N` | scenario port resolver | name hash | Explicitly overrides scenario port assignment. |
| `SEED_DIR=<path>` | scenario start/seed/reset | auto from `scenarios/<name>/` | Explicit seed directory. |
| `WITH_DEFAULTS=1` | scenario start/seed | `0` | Seed default data before scenario seed files. |
| `REF=<git-ref>` | build/deploy/scenario-ref/worktree-ref | CLI args | Equivalent to passing the ref after `--`. |
| `TAG=<image-tag>` | `build:cwd` | `dirty-<timestamp>` | Custom tag for uncommitted working-directory images. |
| `VERSION=<tag>` | release/build prod | CLI args | Equivalent to passing the version after `--`. |
| `LOG_LEVEL=<level>` | backend start tasks | `INFO` | Overrides backend log level. |
| `DONT_RELOAD=true` | full dev start tasks | `false` | Disables uvicorn reload. |
| `AUTO_START_DB=false` | backend-only dev tasks | `true` | Avoids starting dev DB dependency automatically. |
| `LABEL=<why>` | `db:backup:*` | `manual` | Recorded in the backup filename and `.meta` file. |
| `FILE=<path\|latest>` | `db:restore:*` | interactive pick | Backup to restore; `latest` picks the newest. |
| `FROM_ENV=<env>` | `db:restore:*` | target env | Restore from another env's backups (e.g. `FROM_ENV=prod`). |
| `MIGRATE=0` | `db:restore:*` | `1` | Skip Alembic upgrade after restore. |
| `KEEP=N` | `db:backup:prune:*` | `10` | Number of newest backups to keep. |
| `ENV=<env>` / `VERIFY=1` | `db:backup:list` | all / `0` | Filter by env (`scenario:<name>` for scenarios); verify checksums. |

CLI argument rules:

| Pattern | Example | Behavior |
|---------|---------|----------|
| `-- <ref>` | `task build:ref -- feature/x` | Stored in `CLI_ARGS`; common for git refs and revisions. |
| Named var | `task build:ref REF=feature/x` | Same behavior when the task exposes `REF`. |
| Revision args | `task db:downgrade:dev -- -1` | Required when the value begins with `-`. |
| Generic DB copy args | `task db:copy -- staging dev --no-migrate` | Copy migrates by default; parser accepts `--no-migrate`, `--no-backup`, `--dry-run`, and `DRY_RUN=1`. |

---

## Safety Features

Most destructive local operations support `DRY_RUN=1` to preview without executing. Use the command reference for exact support:

```bash
DRY_RUN=1 task deploy:staging:local
DRY_RUN=1 task db:reset:dev
DRY_RUN=1 task db:copy:dev-to-staging
DRY_RUN=1 task stop:dev:volumes
DRY_RUN=1 task build:clean:all
```

Tasks that prompt for confirmation before executing:

- All `db:reset:*` tasks
- All `db:copy:*` tasks
- All `stop:*:volumes` tasks
- `build:ref`, `build:cwd`, and `build:clean:all`
- `git:feature`, `git:fix`, `git:hotfix`, `git:release:tag`, and worktree cleanup tasks
- `deploy:prod:local[:<component>]` and `deploy:prod:local:cwd`
- `stop:scenario` and `stop:scenario:all`
- `db:stamp:dev` and `db:downgrade:dev`

Additional safety gates:

- `task start:prod:local RESET=1` refuses to run unless `FORCE=1` is also provided.
- `task db:cleanup-tags:dev` prompts interactively when running a non-dry-run cleanup without `KEY=<tag-key>`, and prompts again when `ALL=1` would remove system tags.
- `task db:reset:prod` is destructive and prompts, but does not currently implement `DRY_RUN=1`.
- `db:reset:staging:local` and `db:reset:prod:local` take a `pre-reset` backup first; `db:copy` into staging/prod takes a `pre-copy` backup (skip with `--no-backup`).
- `db:restore:*` and `db:copy*` restore into a temporary DB, check it, migrate, then swap it in. The previous DB is kept: undo with `db:restore:rollback:<env>`, or drop it with `db:restore:commit:<env>`. `db:restore:status:<env>` shows both.
- Backups live in `backend/data/backups/<env>/` (scenarios: `backups/scenarios/<name>/`), git-ignored, with a `.meta` provenance file and checksum per dump.
- `task stop:scenario` and `task stop:scenario:all` prompt and remove scenario DB volumes; use `KEEP_BROWSER=1` only to skip isolated browser cleanup, not to keep the DB.

### Browser Safety Flags

| Flag | Purpose |
|------|---------|
| `BROWSER=none|shared|isolated` | Control browser launch for `start:dev`, `start:dev:debug`, `start:dev:frontend`, `start:staging:local`, `start:prod:local`, `start:scenario`, and `start:scenario:ref` |
| `COUNT=N` | Number of isolated browser sessions to open |
| `RESET_BROWSER=1` | Clear isolated browser profiles before opening |
| `KEEP_BROWSER=1` | Keep isolated scenario browser sessions open when stopping scenarios |

---

## Common Workflows

### A. Feature or Fix

```bash
# 1. Branch off develop
git checkout develop && git pull
task git:feature -- my-feature          # or: task git:fix -- bug-123

# 2. Code locally
task start:dev

# 3. Fast tests + scenario QA
task test
task test:backend:int:teardown
SCENARIO=spinoff task start:scenario

# 4. Push + draft PR -> develop
git add . && git commit -m "feat: ..."
task git:pr
task git:pr:checks
task git:pr:ready

# 5. Validate local staging
task deploy:staging:local
task logs:staging:local
```

### B. Backend-Only Change

```bash
task git:feature -- connector-fix
task start:dev:backend
task test:backend:unit

# Scenario QA when behavior is visible to users
SCENARIO=polymarket_pnl task start:scenario

task git:pr && task git:pr:ready
task deploy:staging:local
```

### C. Frontend-Only Change

```bash
task git:feature -- portfolio-ui-fix
task start:dev:frontend
task test:frontend:unit

# Multi-account/manual QA benefits from isolated browser state
SCENARIO=private-accounts task start:scenario BROWSER=isolated COUNT=2

task git:pr && task git:pr:ready
task deploy:staging:local
```

### D. DB Migration

```bash
task git:feature -- add-transaction-field

task db:migrate:dev
task db:check:dev

SCENARIO=spinoff task db:reset:scenario
SCENARIO=spinoff task start:scenario

task git:pr && task git:pr:ready
task deploy:staging:local
```

When migrations and backend code ship together, apply the database migration before validating the backend code against that environment.

### E. Hotfix on Main

```bash
task git:hotfix -- critical-import-bug
# fix + commit

task test
task git:pr
task git:pr:ready

task release:prod -- --fast

# Back-merge so develop has the fix
git checkout develop && git pull
git merge --no-ff origin/main && git push
```

### F. Local-Stack Validation

Use this when debugging container-only issues such as Dockerfile, env wiring, image build args, or entrypoints.

```bash
task deploy:staging:local
task deploy:staging:local:cwd
task stop:staging:local
```

---

## Task Commands Reference

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | DB + backend (reload) + frontend |
| `task start:dev BROWSER=isolated` | Same, opens one isolated Chrome session |
| `task start:dev BROWSER=isolated COUNT=N` | Same, opens N isolated Chrome sessions |
| `task start:dev BROWSER=isolated RESET_BROWSER=1` | Same, but wipes profile dirs first |
| `DONT_RELOAD=true task start:dev` | Start full dev stack without uvicorn reload |
| `LOG_LEVEL=DEBUG task start:dev` | Override backend log level |
| `task start:dev:debug` | Same + debugpy on port 5678 |
| `task start:dev:db` | Dev database only |
| `task start:dev:db RESET=1` | Recreate dev DB container/volume before start |
| `task start:dev:backend` | Backend only |
| `AUTO_START_DB=false task start:dev:backend` | Backend only without auto-starting dev DB |
| `task start:dev:backend:debug` | Backend only + debugpy |
| `task start:dev:frontend` | Frontend only |
| `task start:dev:frontend BROWSER=isolated COUNT=N` | Frontend only plus isolated browser sessions |
| `task stop:dev` | Stop all dev services |
| `task stop:dev:db` | Stop dev database only |
| `task stop:dev:backend` | Stop dev backend process only |
| `task stop:dev:frontend` | Stop dev frontend/Vite process only |
| `task stop:dev:volumes` | Stop dev + destroy DB data |
| `DRY_RUN=1 task stop:dev:volumes` | Preview dev volume removal |

### Deploy - Staging Local (docker-compose)

| Command | Description |
|---------|-------------|
| `task deploy:staging:local -- [<ref>] [db backend frontend] [--all] [--dry-run] [--skip-ci-check]` | Deploy changed components of a develop commit (default `origin/develop`) |
| `task deploy:staging:local:<component> -- <ref>` | Deploy one component from a develop commit |
| `task deploy:staging:local:ref -- <ref>` | Quick full rebuild from any git ref (`DRY_RUN=1` to preview, not recorded) |
| `task deploy:staging:local:cwd[:<component>]` | Deploy from the working directory |
| `task start:staging:local` | Start local staging with existing images |
| `task start:staging:local RESET=1` | Tear down local staging before starting |
| `task start:staging:local BROWSER=isolated COUNT=1 RESET_BROWSER=1` | Same, with an isolated browser session |
| `task stop:staging:local` | Stop local staging stack |
| `task stop:staging:local:volumes` | Stop + destroy staging data |
| `DRY_RUN=1 task stop:staging:local:volumes` | Preview staging volume removal |
| `task logs:staging:local` | Tail local staging logs |

### Deploy - Production Local

| Command | Description |
|---------|-------------|
| `task release:prod[:<component>]` | Tag `<component>-vX.Y.Z` on main + deploy (see above) |
| `task deploy:prod:local:<component> -- <tag>` | Deploy one component (`db`, `backend`, `frontend`) from a release tag |
| `task deploy:prod:local:cwd[:<component>]` | Deploy from the working directory (not recorded) |
| `task deploy:prod:local -- <vX.Y.Z>` | Full db + backend + frontend deploy from one legacy release tag |
| `task deploy:prod:current` | Current prod backend tag |
| `task deploy:prod:status[:<component>][:diff]` | What is deployed vs released / origin/main |
| `task deploy:staging:status` | What is deployed to local staging vs origin/develop |
| `task start:prod:local` | Start local prod with the deployed `:prod` images |
| `task start:prod:local RESET=1 FORCE=1` | Tear down prod-local before starting; `FORCE=1` is required |
| `task start:prod:local BROWSER=isolated COUNT=1 RESET_BROWSER=1` | Same, with an isolated browser session |
| `task stop:prod:local` | Stop local prod stack |
| `task stop:prod:local:volumes` | Stop + destroy prod-local data |
| `DRY_RUN=1 task stop:prod:local:volumes` | Preview prod-local volume removal |
| `task logs:prod:local` | Tail prod-local logs |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate:dev` (alias `db:migrate`) | Dev alembic upgrade head |
| `task db:migrate:staging:local` | Local staging migrations |
| `task db:migrate:prod:local` | Local prod migrations |
| `task db:seed:dev` (alias `db:seed`) | Seed dev DB |
| `task db:seed:staging:local` | Seed local staging DB |
| `task db:reset:dev` | Drop + reseed dev DB |
| `DRY_RUN=1 task db:reset:dev` | Preview dev DB reset |
| `task db:reset:staging:local` | Drop + reseed local staging DB |
| `DRY_RUN=1 task db:reset:staging:local` | Preview local staging DB reset |
| `task db:reset:prod:local` | Drop + reseed local prod DB |
| `task start:scenario:db SCENARIO=<name>` | Create and seed a scenario DB (used by integration/e2e tests too) |
| `task stop:scenario SCENARIO=<name>` | Tear down a scenario instance (DB + volume) |
| `task db:copy:dev-to-staging` | Copy dev -> staging (`DRY_RUN=1` to preview) |
| `task db:copy:staging-to-dev` | Copy staging -> dev |
| `task db:copy:prod-to-staging` | Copy prod-local -> staging |
| `task db:copy:staging-to-prod` | Copy staging -> prod-local |
| `task db:copy -- <src> <dst> [--dry-run] [--no-migrate] [--no-backup]` | Generic copy between local envs (`dev`, `staging`, `prod`, `scenario`); migrates target by default |
| `task db:copy -- dev staging DRY_RUN=1` | Generic copy dry run; accepted after `--` |
| `task db:backup:dev` / `db:backup:staging` / `db:backup:prod` / `db:backup:scenario SCENARIO=<name>` | Back up a DB (`LABEL=<why>`) |
| `task db:backup:list [ENV=<env>] [VERIFY=1]` | List backups and provenance |
| `task db:backup:prune:<env> [KEEP=10] [DRY_RUN=1]` | Delete old backups |
| `task db:restore:<env> [FILE=<path\|latest>] [FROM_ENV=<env>] [MIGRATE=0] [DRY_RUN=1]` | Restore a backup (interactive pick by default) |
| `task db:restore:status:<env>` | Show live + kept-for-rollback DBs |
| `task db:restore:rollback:<env>` | Undo the last restore/copy |
| `task db:restore:commit:<env>` | Keep the last restore/copy; drop the previous DB |
| `task db:status:dev` | Alembic current/head status |
| `task db:status:staging:local` | Alembic status inside local staging backend container |
| `task db:status:prod:local` | Alembic status inside local prod backend container |
| `task script ENV=dev\|staging:local\|prod:local -- <script> [args]` | Run `backend/scripts/<script>` with that env's config (prod prompts; `YES=1` skips) |
| `task db:check:dev` | Validate migration health |
| `task db:check:staging:local` / `db:check:prod:local` (aliases `db:check:staging` / `db:check:prod`) | Connectivity + migration state |
| `task db:migrate:scenario SCENARIO=<name>` | Migrate a scenario DB |
| `task db:history:dev` | Show verbose Alembic history |
| `task db:merge:dev -- "message"` | Merge multiple Alembic heads |
| `task db:stamp:dev -- <revision>` | Stamp DB revision without running migrations |
| `task db:downgrade:dev -- <revision>` | Roll back dev migrations; use `-- -1` for one step |
| `task db:cleanup-tags:dev DRY_RUN=1` | Preview dev transaction tag cleanup |
| `task db:cleanup-tags:dev KEY=<tag-key>` | Clean only one tag key in dev |
| `task db:cleanup-tags:dev ALL=1` | Include system tags; prompts again before execution |
| `task db:cleanup-tags:staging:local DRY_RUN=1` | Preview local staging tag cleanup |

### Scenario

| Command | Description |
|---------|-------------|
| `task start:scenario` | Local code + Docker DB + live reload |
| `task start:scenario SCENARIO=<name>` | Named scenario with deterministic ports |
| `task start:scenario SCENARIO=<name> RESET=1` | Tear down/recreate named scenario first |
| `task start:scenario SCENARIO=<name> WITH_DEFAULTS=1` | Seed defaults before scenario-specific data |
| `task start:scenario SCENARIO=<name> SEED_DIR=<path>` | Use explicit seed directory |
| `task start:scenario SCENARIO=<name> PORT_OFFSET=N` | Override hash-derived ports |
| `task start:scenario BROWSER=isolated` | Same, opens one isolated Chrome session |
| `task start:scenario BROWSER=isolated COUNT=N` | Same, opens N isolated Chrome sessions |
| `task start:scenario BROWSER=isolated RESET_BROWSER=1` | Same, but wipes profile dirs first |
| `task start:scenario:ref -- <ref>` | All-Docker from git ref |
| `task start:scenario:ref REF=<ref> SCENARIO=<name>` | Same using named ref and scenario params |
| `task start:scenario:ref BROWSER=isolated COUNT=N -- <ref>` | Same, opens N isolated Chrome sessions |
| `task stop:scenario` | Stop one scenario and close isolated Chrome sessions |
| `task stop:scenario KEEP_BROWSER=1` | Stop one scenario but leave browser sessions open |
| `task stop:scenario:all` | Stop all scenarios and close isolated Chrome sessions |
| `task stop:scenario:all KEEP_BROWSER=1` | Stop all scenarios but keep isolated browser sessions |
| `task db:seed:scenario` | Seed scenario DB |
| `task db:seed:scenario SCENARIO=<name> WITH_DEFAULTS=1` | Seed defaults, then named scenario data |
| `task db:seed:scenario SEED_DIR=<path>` | Seed from explicit directory |
| `task db:reset:scenario` | Reset scenario DB |
| `DRY_RUN=1 task db:reset:scenario SCENARIO=<name>` | Preview scenario DB reset |
| `task logs:scenario` | Tail scenario logs |

All scenario commands accept `SCENARIO=<name>`.

### Browser

| Command | Description |
|---------|-------------|
| `task open:shared:dev` | Focus/open dev in the default Chrome profile |
| `task open:shared:scenario SCENARIO=<name>` | Same, on a scenario |
| `task open:shared:staging:local` | Same, on local staging |
| `task open:shared:prod:local` | Same, on local prod |
| `task open:isolated:dev [COUNT=N] [RESET_BROWSER=1]` | Open isolated Chrome sessions on dev |
| `task open:isolated:scenario SCENARIO=<name> [COUNT=N] [RESET_BROWSER=1]` | Same, on a scenario |
| `task open:isolated:staging:local [COUNT=N] [RESET_BROWSER=1]` | Same, on local staging |
| `task open:isolated:prod:local [COUNT=N] [RESET_BROWSER=1]` | Same, on local prod |
| `task open:clean` | Remove all isolated Chrome profile dirs |
| `task open:clean:dev` | Remove only dev isolated profile dirs |
| `task open:clean:scenario` | Remove scenario isolated profile dirs |
| `task open:clean:scenario SCENARIO=<name>` | Remove isolated profiles for one scenario |

### Git & Release

| Command | Description |
|---------|-------------|
| `task git:feature -- <name>` | Create feature branch from develop |
| `task git:fix -- <name>` | Create fix branch from develop |
| `task git:hotfix -- <name>` | Create hotfix branch from main |
| `task git:pr` | Push + create draft PR |
| `task git:pr:draft` | Explicit draft PR command |
| `task git:pr:publish` | Push + create ready PR |
| `task git:pr:ready` | Mark draft as ready |
| `task git:pr:view` | Open current PR in browser |
| `task git:pr:checks` | Show CI status |
| `task git:pr:merge` | Squash merge |
| `task git:release:prepare` | Create develop -> main release PR |
| `task git:release:tag-component COMPONENT=<c> VERSION=v1.0.0` | Tag `<c>-v1.0.0` on main (used by `release:prod:*`) |
| `task git:release:tag -- v1.0.0` | Legacy whole-app tag on main |
| `task git:release:ready` | Mark develop -> main release PR ready |
| `task git:release:merge` | Merge develop -> main release PR |
| `task git:tags` | List version tags (per-component + legacy) |
| `task release` | Alias of `task release:prod` |

Git worktree commands used by builds:

| Command | Description |
|---------|-------------|
| `task git:worktree:create -- <branch\|ref>` | `main`/`develop` → persistent snapshot; any other ref → detached `.worktrees/ref-<sha>` |
| `task git:worktree:status` | List active worktrees and disk usage |
| `task git:worktree:update` (alias `setup`) | Create/refresh detached main/develop snapshots from origin refs |
| `task git:worktree:clean:ref` | Remove temporary ref worktrees only |
| `task git:worktree:clean` | Remove all managed worktrees |

### Build

| Command | Description |
|---------|-------------|
| `task build:staging` | Build images from develop |
| `task build:staging:backend` | Build backend image from develop |
| `task build:staging:frontend` | Build frontend image from develop |
| `task build:prod -- v1.0.0` | Build images from main |
| `task build:prod:backend -- v1.0.0` | Build backend image from main and tag latest |
| `task build:prod:frontend -- v1.0.0` | Build frontend image from main and tag latest |
| `task build:ref -- <ref>` | Build from any git ref |
| `task build:ref REF=<ref>` | Same using named parameter; creates temp ref worktree |
| `task build:cwd` (alias `build:dirty`) | Build from working directory |
| `task build:cwd TAG=<tag>` | Build from working directory using explicit tag |
| `task build:list` | List Docker images |
| `task build:clean` | Remove old images |
| `task build:clean:all` | Remove all trades-exporter images |
| `DRY_RUN=1 task build:clean:all` | Preview image removal |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests (backend + frontend) |
| `task test:unit` | Full unit suite |
| `task test:backend:unit` | Backend unit + API tests |
| `task test:frontend:unit` | Frontend type check + build |
| `task test:backend:int` | Integration tests (includes live-API tests, which self-skip when flaky) |
| `task test:backend:int:teardown` | Setup + integration + scenario teardown |
| `task test:backend:e2e` | Backend end-to-end tests (self-contained; provisions its own scenario DB) |
| `task test:frontend:e2e` | Frontend Playwright smoke tests (no backend) |
| `task test:e2e` | Full-stack e2e: frontend Playwright against a real backend + db (dedicated scenario) |
| `task test:backend` | All backend tests: unit + integration + e2e |
| `task test:frontend` | All frontend tests: unit + e2e smoke |
| `task test:all` | Full suite: backend + frontend + full-stack e2e |

### Utilities

| Command | Description |
|---------|-------------|
| `task install` | Install all dependencies |
| `task install:backend` | Install backend Python dependencies |
| `task install:frontend` | Install frontend Node dependencies |
| `task status` | Show running containers |
| `task scenarios` | List scenario instances + ports |
| `task logs:dev` | Tail dev database logs |
| `task help` | Quick reference |

---

## Known Gaps vs Reference Workflow

The document now matches the implemented local workflow. Remaining differences from the salsa-events-calendar workflow are intentional unless noted below.

| Gap | Status | Plan |
|-----|--------|------|
| Remote hosting (Fly.io, Neon, Cloudflare) | Removed by design — staging and prod are local Docker Compose stacks. | — |
| App-specific reference features (Umami, MinIO objects, notify, showcase, secrets sync) | Not applicable to this app. | — |
| Browser cleanup for local staging/prod | Not needed today. Browser cleanup is automatic for scenario stop tasks only. | If isolated staging/prod sessions become common, add `KEEP_BROWSER=1` and cleanup calls to `stop:staging:local` and `stop:prod:local`. |
| Performance testing section | Intentionally omitted because this repo has no `perf:*` task namespace. | Add k6/perf taskfiles and scenarios first, then mirror the reference performance section. |

---

## Port Reference

| Service | dev | staging:local | scenario (default) | prod:local |
|---------|-----|---------------|--------------------|------------|
| PostgreSQL | 5432 | 5433 | 5435 | 5434 |
| Backend | 8000 | 8001 | 8002 | 8080 |
| Frontend | 5173 | 3001 | 3002 | 3000 |
| Debugger | 5678 | - | - | - |

Scenario ports are deterministic per scenario name. Run `task scenarios` to see all current assignments.

---

## Troubleshooting

### Database Connection Failed

```bash
docker ps | grep trades_db_dev
task start:dev:db
task db:check:dev
```

### Port Already In Use

```bash
lsof -i :8000
kill -9 <PID>
```

### Docker Images Not Found

```bash
task build:list
task build:staging
task build:prod -- v1.0.0
```

### Reset Everything

```bash
task stop:dev && task stop:staging:local
DRY_RUN=1 task stop:dev:volumes
task stop:dev:volumes
```
