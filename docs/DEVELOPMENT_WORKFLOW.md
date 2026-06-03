# Development Workflow

This document describes the local development, QA, testing, and release workflow for the trades-exporter project.

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

Remote deployment is intentionally out of scope for this workflow. The local workflow mirrors the salsa-events-calendar structure where it applies, but omits Fly.io, Neon, Cloudflare Pages, deployment refs, and remote component release flows.

Note: some remote/Fly tasks still exist in the Taskfile implementation from the parity refactor. They are intentionally not part of this local workflow guide; see [Known Gaps vs Reference Workflow](#known-gaps-vs-reference-workflow).

---

## Env & Secrets Files

Tasks load environment files in layers. Shared defaults come from `config/base.env`; environment-specific files override those values; secret files are gitignored.

| File | Committed | Loaded by |
|------|-----------|-----------|
| `config/base.env` | yes | all tasks; shared non-secret defaults |
| `config/dev.env` | yes | `dev` tasks |
| `config/staging.env` | yes | `staging:local` tasks |
| `config/prod.env` | yes | `prod:local` tasks |
| `config/scenario.env` | yes | scenario tasks |
| `config/secrets.env` | no | shared local secrets |
| `config/secrets.dev.env` | no | dev-only secrets |
| `config/secrets.staging.env` | no | local staging secrets |
| `config/secrets.prod.env` | no | local prod secrets |
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
task test:unit:backend  # backend only
task test:unit:frontend # frontend type check + build
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
task test:unit:backend  # backend unit + API tests
task test:unit:frontend # frontend type check + build
task test:int           # integration tests; requires integration DB setup
task test:int:full      # setup -> test -> cleanup
task test:all           # unit + integration + e2e
task test:ci            # simulate CI locally via Act
```

Useful integration chunks:

```bash
task test:int:cex       # CEX connectors
task test:int:onchain   # onchain connectors
task test:int:prices    # price getters
task test:int:db        # DB operations
task test:int:exchanges # exchange-specific integrations
task test:e2e           # e2e tests; requires running DB
```

Integration tests use a separate `trades_db_integ` database on the dev Postgres server. Use `task db:setup:integ` to create/stamp/seed it, or `task test:int:full` to run setup, integration tests, and reset in one flow.

---

## Deployment

### Staging Local (docker-compose)

Validates Docker images in a fully containerized stack.

```bash
task deploy:staging:local                   # build from develop branch
task deploy:staging:local:ref -- feature/x  # build from any git ref
task deploy:staging:local:ref REF=feature/x # equivalent named parameter
task deploy:staging:local:cwd               # build from working directory

DRY_RUN=1 task deploy:staging:local          # preview without executing
DRY_RUN=1 task deploy:staging:local:ref -- feature/x
DRY_RUN=1 task deploy:staging:local:cwd
```

The local staging stack uses `config/base.env`, `config/staging.env`, `config/secrets.env`, and `config/secrets.staging.env`.

### Production Local

Production-local is a local Docker Compose stack using versioned images from `main`.

```bash
task git:release:prepare
task git:release:ready
task git:release:merge
task git:release:tag -- v1.2.0
task deploy:prod:local -- v1.2.0
DRY_RUN=1 task deploy:prod:local -- v1.2.0
```

The shortcut below tags and deploys local prod in one flow:

```bash
task release -- v1.2.0
```

`task deploy:prod:local -- <ref>` first looks for an existing `trades-exporter-backend:<ref>` image. If no image exists, it attempts to build from the git ref and deploys the resulting `ref-<sha>` image tag. Omitting the ref deploys `latest`.

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
| `DRY_RUN=1` | deploy, DB reset/copy, stop volume cleanup, build clean-all, tag cleanup | `0` | Prints planned actions without mutating state where implemented. |
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
| `TAG=<image-tag>` | `build:dirty` | `dirty-<timestamp>` | Custom tag for uncommitted working-directory images. |
| `VERSION=<tag>` | release/build prod | CLI args | Equivalent to passing the version after `--`. |
| `LOG_LEVEL=<level>` | backend start tasks | `INFO` | Overrides backend log level. |
| `DONT_RELOAD=true` | full dev start tasks | `false` | Disables uvicorn reload. |
| `AUTO_START_DB=false` | backend-only dev tasks | `true` | Avoids starting dev DB dependency automatically. |

CLI argument rules:

| Pattern | Example | Behavior |
|---------|---------|----------|
| `-- <ref>` | `task build:ref -- feature/x` | Stored in `CLI_ARGS`; common for git refs and revisions. |
| Named var | `task build:ref REF=feature/x` | Same behavior when the task exposes `REF`. |
| Revision args | `task db:downgrade:dev -- -1` | Required when the value begins with `-`. |
| Generic DB copy args | `task db:copy -- staging dev --migrate` | Parser accepts `--migrate`, `--dry-run`, and `DRY_RUN=1`. |

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
- `build:ref`, `build:dirty`, and `build:clean:all`
- `git:feature`, `git:fix`, `git:hotfix`, `git:release:tag`, and worktree cleanup tasks
- `deploy:prod:local`
- `stop:scenario` and `stop:scenario:all`
- `db:stamp:dev` and `db:downgrade:dev`

Additional safety gates:

- `task start:prod:local RESET=1` refuses to run unless `FORCE=1` is also provided.
- `task db:cleanup-tags:dev` prompts interactively when running a non-dry-run cleanup without `KEY=<tag-key>`, and prompts again when `ALL=1` would remove system tags.
- `task db:reset:prod` is destructive and prompts, but does not currently implement `DRY_RUN=1`.
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
task test:int:full
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
task test:unit:backend

# Scenario QA when behavior is visible to users
SCENARIO=polymarket_pnl task start:scenario

task git:pr && task git:pr:ready
task deploy:staging:local
```

### C. Frontend-Only Change

```bash
task git:feature -- portfolio-ui-fix
task start:dev:frontend
task test:unit:frontend

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

task git:release:tag -- v1.2.1
task deploy:prod:local -- v1.2.1

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
| `task deploy:staging:local` | Build from develop + docker-compose up |
| `DRY_RUN=1 task deploy:staging:local` | Preview develop -> local staging deploy |
| `task deploy:staging:local:ref -- <ref>` | Build from git ref + docker-compose up |
| `task deploy:staging:local:ref REF=<ref>` | Same using named parameter |
| `DRY_RUN=1 task deploy:staging:local:ref -- <ref>` | Preview git-ref local staging deploy |
| `task deploy:staging:local:cwd` | Build from working directory + docker-compose up |
| `DRY_RUN=1 task deploy:staging:local:cwd` | Preview dirty working-directory local staging deploy |
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
| `task deploy:prod:local -- <tag-or-ref>` | Deploy local prod from a version tag or image tag |
| `task deploy:prod:local REF=<tag-or-ref>` | Same using named parameter |
| `DRY_RUN=1 task deploy:prod:local -- <tag-or-ref>` | Preview prod-local deploy |
| `task start:prod:local` | Start local prod with existing images |
| `task start:prod:local RESET=1 FORCE=1` | Tear down prod-local before starting; `FORCE=1` is required |
| `task start:prod:local BROWSER=isolated COUNT=1 RESET_BROWSER=1` | Same, with an isolated browser session |
| `task stop:prod:local` | Stop local prod stack |
| `task stop:prod:local:volumes` | Stop + destroy prod-local data |
| `DRY_RUN=1 task stop:prod:local:volumes` | Preview prod-local volume removal |
| `task logs:prod:local` | Tail prod-local logs |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate:dev` | Dev alembic upgrade head |
| `task db:migrate:staging` | Local staging migrations |
| `task db:migrate:prod` | Local prod migrations |
| `task db:seed:dev` | Seed dev DB |
| `task db:seed:staging` | Seed local staging DB |
| `task db:reset:dev` | Drop + reseed dev DB |
| `DRY_RUN=1 task db:reset:dev` | Preview dev DB reset |
| `task db:reset:staging` | Drop + reseed local staging DB |
| `DRY_RUN=1 task db:reset:staging` | Preview local staging DB reset |
| `task db:reset:prod` | Drop + reseed local prod DB |
| `task db:setup:integ` | Create and seed integration DB |
| `task db:reset:integ` | Reset integration DB |
| `task db:copy:dev-to-staging` | Copy dev -> staging (`DRY_RUN=1` to preview) |
| `task db:copy:staging-to-dev` | Copy staging -> dev and run migrations |
| `task db:copy:staging-to-prod` | Copy staging -> prod-local |
| `task db:copy -- <src> <dst> [--dry-run]` | Generic copy between local envs |
| `task db:copy -- staging dev --migrate` | Generic copy plus Alembic upgrade on target |
| `task db:copy -- dev staging DRY_RUN=1` | Generic copy dry run; accepted after `--` |
| `task db:status:dev` | Alembic current/head status |
| `task db:status:staging` | Alembic status inside local staging backend container |
| `task db:check:dev` | Validate migration health |
| `task db:history:dev` | Show verbose Alembic history |
| `task db:merge:dev -- "message"` | Merge multiple Alembic heads |
| `task db:stamp:dev -- <revision>` | Stamp DB revision without running migrations |
| `task db:downgrade:dev -- <revision>` | Roll back dev migrations; use `-- -1` for one step |
| `task db:cleanup-tags:dev DRY_RUN=1` | Preview dev transaction tag cleanup |
| `task db:cleanup-tags:dev KEY=<tag-key>` | Clean only one tag key in dev |
| `task db:cleanup-tags:dev ALL=1` | Include system tags; prompts again before execution |
| `task db:cleanup-tags:staging DRY_RUN=1` | Preview local staging tag cleanup |

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
| `task git:release:tag -- v1.0.0` | Tag release on main |
| `task git:release:tag VERSION=v1.0.0` | Same using named parameter |
| `task git:release:ready` | Mark develop -> main release PR ready |
| `task git:release:merge` | Merge develop -> main release PR |
| `task git:tags` | List version tags |
| `task release -- v1.0.0` | Tag main + deploy local prod |

Git worktree commands used by builds:

| Command | Description |
|---------|-------------|
| `task git:worktree:setup` | Create persistent `.worktrees/main` and `.worktrees/develop` |
| `task git:worktree:setup:ref -- <ref>` | Create `.worktrees/ref-<sha>` for a git ref |
| `task git:worktree:status` | List active worktrees and disk usage |
| `task git:worktree:update` | Pull persistent main/develop worktrees |
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
| `task build:dirty` | Build from working directory |
| `task build:dirty TAG=<tag>` | Build from working directory using explicit tag |
| `task build:list` | List Docker images |
| `task build:clean` | Remove old images |
| `task build:clean:all` | Remove all trades-exporter images |
| `DRY_RUN=1 task build:clean:all` | Preview image removal |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests |
| `task test:unit` | Full unit suite |
| `task test:unit:backend` | Backend unit + API tests |
| `task test:unit:frontend` | Frontend type check + build |
| `task test:int` | Integration tests |
| `task test:int:cex` | Integration: CEX connector tests |
| `task test:int:onchain` | Integration: onchain connector tests |
| `task test:int:prices` | Integration: price getter tests |
| `task test:int:db` | Integration: DB-only tests |
| `task test:int:exchanges` | Integration: exchange-specific tests |
| `task test:int:full` | Setup + integration |
| `task test:e2e` | End-to-end tests; requires running database |
| `task test:all` | All tests |
| `task test:ci` | Simulate CI via Act |

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
| Remote deployment sections and commands | Intentionally omitted from this doc because this project is expected to be local-only for now. Current taskfiles still contain `deploy:*:remote`, `fly:*`, and remote `open:*` tasks from the earlier refactor. | Decide whether to remove those task namespaces entirely or keep them undocumented as experimental. If local-only is final, delete `.taskfiles/fly.yml`, remote deploy tasks, remote open tasks, and remote env examples in a follow-up cleanup. |
| `task help` still advertises remote commands | Implementation mismatch with this local-only workflow guide. `task help` currently lists remote staging/prod deploy and Fly status commands. | Update `Taskfile.yml` help output after deciding whether remote tasks are removed or kept experimental. If removed, also remove remote log/open entries from `task --list`. |
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
