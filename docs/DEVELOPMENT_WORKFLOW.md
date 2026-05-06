# Development Workflow

This document describes the CI/CD workflow for the trades-exporter project.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Daily Development Workflow](#daily-development-workflow)
- [Branching Strategy](#branching-strategy)
- [Deployment](#deployment)
- [Scenario Environment](#scenario-environment)
- [Testing](#testing)
- [Safety Features](#safety-features)
- [Task Commands Reference](#task-commands-reference)

---

## Prerequisites

Install these tools before starting:

```bash
# macOS
brew install go-task/tap/go-task  # Taskfile runner
brew install gh                    # GitHub CLI
brew install act                   # Local CI runner (optional)

# Verify installations
task --version
gh --version
docker --version
```

## Quick Start

```bash
# 1. Clone the repository
git clone <repository-url>
cd trades-exporter

# 2. Install dependencies
task install

# 3. Start development environment
task start:dev:debug

# 4. Open in browser
# Frontend: http://localhost:5173
# Backend:  http://localhost:8000/docs
```

---

## Environment Overview

| Environment | Purpose | Database Port | Backend Port | Frontend Port |
|-------------|---------|---------------|--------------|---------------|
| **Dev** | Local development with VSCode debugging | 5432 | 8000 | 5173 |
| **Staging** | Containerized integration environment | 5433 | 8001 | 3001 |
| **Scenario** | Isolated manual testing with scenario data | 5435+ | 8002+ | 3002+ |
| **Prod** | Production (local or cloud) | 5434 | 8080 | 3000 |

> **Scenario ports** are per-instance. The default instance uses 5435/8002/3002. Each named scenario gets a deterministic offset (e.g. `fr_tax` → 5440/8007/3007). See [Port Allocation](#scenario-port-allocation) for the full map.

### Dev Environment

- **Database**: Docker container
- **Backend**: Local Python process (debuggable)
- **Frontend**: Vite dev server (hot reload)

### Staging Environment

- Fully containerized (Docker Compose)
- Built from `develop` branch
- Uses `:develop` tagged images

### Scenario Environment

- Isolated full stack for manual scenario testing
- Default mode: local code + Docker DB + live reload (like dev)
- Optional `:ref` mode: all-Docker from any git ref, tag, or branch
- Supports scenario data overlays (custom YAML seed folders)
- **Multi-instance**: run multiple scenarios simultaneously with `SCENARIO=<name>` — each gets isolated DB, ports, and containers
- `task stop:scenario SCENARIO=<name>` cleans up a single instance; `task stop:scenario:all` cleans up everything

### Prod Environment

- Fully containerized (Docker Compose)
- Built from `main` branch with semantic version tags
- Uses versioned images (e.g., `:v1.2.0`)

---

## Daily Development Workflow

### 1. Start Your Day

```bash
# Update develop branch
git checkout develop
git pull origin develop

# Create feature branch
task git:feature -- my-feature-name
```

### 2. Start Development Environment

```bash
# Start database + backend (with debugger) + frontend
task start:dev:debug
```

Services running:

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:8000>
- Swagger Docs: <http://localhost:8000/docs>
- Debugger: Port 5678 (attach from VSCode)

### 3. Attach VSCode Debugger

1. Press `F5` in VSCode
2. Select **"Backend: Attach"** or **"Full Stack Debug"**
3. Set breakpoints and debug!

### 4. Run Tests

```bash
# Quick unit tests
task test

# Full test suite
task test:unit

# Backend only
task test:unit:backend
```

### 5. Commit and Create PR

```bash
# Commit your changes
git add .
git commit -m "feat: add my feature"

# Push and create draft PR (auto-detects target: develop or main for hotfix/*)
task git:pr
```

### 6. End of Day

```bash
# Stop services
task stop:dev
```

---

## Branching Strategy

```
main (production)
├── hotfix/critical-bug     → Direct PR to main
│
develop (integration)
├── feature/new-feature     → PR to develop
├── fix/bug-fix             → PR to develop
```

### Branch Types

| Type | Base | Purpose | Command |
|------|------|---------|---------|
| `feature/*` | develop | New features | `task git:feature -- <name>` |
| `fix/*` | develop | Bug fixes | `task git:fix -- <name>` |
| `hotfix/*` | main | Critical prod fixes | `task git:hotfix -- <name>` |

### Pull Request Flow

```bash
# Create feature branch
task git:feature -- my-feature

# ... make changes ...

# Create draft PR (auto-detects target: develop, or main for hotfix/*)
task git:pr

# When ready for review
task git:pr:ready

# View PR status
task git:pr:checks

# After approval, merge (shows next steps: deploy:staging or git:release:tag)
task git:pr:merge
```

---

## Deployment

### Deploy to Staging

Staging deployments are built from the `develop` branch:

```bash
# Build and deploy to staging
task deploy:staging
```

This will:

1. Build Docker images from develop (via git worktree — no branch switching)
2. Tag images as `:develop`
3. Start the staging stack on ports 8001/3001

Access: <http://localhost:3001>

You can also deploy from any git ref or your working directory:

```bash
# Deploy from a specific branch/tag
task deploy:staging:ref -- feature/my-branch

# Deploy from uncommitted working directory
task deploy:staging:dirty
```

> All deploy tasks support `DRY_RUN=1` to preview without executing.

### Deploy to Production

Production deployments use tagged versions:

```bash
# 1. Create release PR (develop → main)
task git:release:prepare

# 2. Mark it ready for review
task git:release:ready

# 3. Merge the release PR
task git:release:merge

# 4. Tag the release on main
task git:release:tag -- v1.2.0

# 5. Deploy the tagged version
task deploy:prod -- v1.2.0
```

Or use the combo command (tag + deploy in one step):

```bash
task release -- v1.2.0
```

Access: <http://localhost:3000>

### Cloud Deployment (Fly.io + Cloudflare Pages + Neon)

Remote deployments use:

- **Fly.io** — backend container (`fly.toml` for prod, `fly.staging.toml` for staging)
- **Cloudflare Pages** — frontend SPA (configured via `wrangler.toml` + dashboard)
- **Neon Postgres** — managed database (separate `develop` and `main` branches)

Setup once per environment:

1. Copy `config/secrets.staging.env.example` → `config/secrets.staging.env` and fill in `DATABASE_URL` (Neon), `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repeat for `prod`.
2. Authenticate the Fly CLI (`fly auth login`) and confirm `npx wrangler whoami` works.
3. Create the Fly apps once: `fly apps create trades-exporter-staging` and `fly apps create trades-exporter`.
4. Create the Cloudflare Pages project (`trades-exporter`) in the dashboard with build output `frontend/dist` and the `VITE_API_URL` / `NODE_VERSION` env vars described in `wrangler.toml`.

Deploy:

```bash
task deploy:staging:remote   # full stack: DB migrations + Fly backend + CF Pages frontend
task deploy:prod:remote      # production (prompts for confirmation)
```

Atomic single-component variants are also available (`deploy:<env>:remote:db`, `:backend`, `:frontend`).

---

## Scenario Environment

The scenario environment lets you spin up an isolated full stack, seed it with scenario-specific test data, and manually verify features.

### Scenario Folders

A scenario folder contains YAML files in the same format as `backend/db/seed_data/`. Only include what you need — defaults are loaded first, then the scenario layers on top.

```
scenarios/fr_tax/
├── accounts.yaml        # Optional: extra accounts (PEA, AV envelopes)
├── assets.yaml          # Optional: extra assets
├── bundles.yaml         # Optional: bundle overrides
└── transactions.yaml    # The test trades
```

Seeding is idempotent: assets upsert by symbol, accounts by name, transactions by `(source, source_transaction_id)`. The scenario only needs the *extra* data specific to that test case.

### Default Mode (Local Code + Live Reload)

Runs only the database in Docker; backend and frontend run locally with hot reload. This is the default because it's fastest for development:

```bash
# Default instance (ports 5435/8002/3002)
task start:scenario

# Named scenario — gets its own DB, ports, and containers
task start:scenario SCENARIO=fr_tax

# Run a second scenario simultaneously in another terminal
task start:scenario SCENARIO=polymarket_pnl
```

Code changes reflect immediately without rebuilding images.

### Docker Mode (From Git Ref)

Builds and deploys all services in containers — identical to staging/prod deployments:

```bash
# From a branch (uses git worktree, no branch switching)
task start:scenario:ref -- feature/new-pnl-drilldown

# From a branch with a named scenario (auto-resolves SEED_DIR + unique ports)
task start:scenario:ref -- feature/new-pnl-drilldown SCENARIO=fr_tax

# From a tag
task start:scenario:ref -- v1.2.0 SCENARIO=polymarket_pnl
```

> **SEED_DIR auto-resolution**: When `SCENARIO` matches a folder in `scenarios/`, the seed directory is resolved automatically. You can still pass `SEED_DIR=...` explicitly to override.

### Running Multiple Scenarios

Each scenario runs on isolated ports with its own database:

```bash
# Terminal 1: fr_tax scenario
task start:scenario SCENARIO=fr_tax
# → DB:5440  API:8007  WEB:3007

# Terminal 2: polymarket_pnl scenario
task start:scenario SCENARIO=polymarket_pnl
# → DB:5441  API:8008  WEB:3008

# Terminal 3: default (no SCENARIO)
task start:scenario
# → DB:5435  API:8002  WEB:3002
```

For scenarios not in the built-in port map, supply an explicit offset:

```bash
task start:scenario SCENARIO=my_custom PORT_OFFSET=15
# → DB:5450  API:8017  WEB:3017
```

### Seeding a Running Scenario

```bash
# Re-seed default instance with defaults
task db:seed:scenario

# Seed a specific scenario instance
task db:seed:scenario SCENARIO=fr_tax

# Full reset (truncate + reseed)
task db:reset:scenario SCENARIO=fr_tax
```

### Lifecycle

```bash
# Tail logs for a specific instance
task logs:scenario SCENARIO=fr_tax

# Stop one instance
task stop:scenario SCENARIO=fr_tax

# Stop ALL scenario instances at once
task stop:scenario:all
```

---

## Testing

### Unit Tests

```bash
task test               # All unit tests
task test:unit:backend  # Backend only
task test:unit:frontend # Frontend type check + build
```

### Integration Tests

```bash
# Setup integration DB (one-time)
task db:setup:integ

# Run all integration tests
task test:int

# Or run the full cycle (setup → test → cleanup)
task test:int:full

# Run specific test groups
task test:int:cex       # CEX connectors
task test:int:onchain   # Onchain connectors
task test:int:prices    # Price getters
task test:int:db        # DB operations
```

### End-to-End Tests

```bash
task test:e2e           # Requires running database
```

### CI Simulation

Test the full CI pipeline locally:

```bash
task test:ci
```

---

## Safety Features

### DRY_RUN=1

All destructive operations support `DRY_RUN=1` to preview what would happen without executing:

```bash
# Preview a database reset
DRY_RUN=1 task db:reset:dev

# Preview a deployment
DRY_RUN=1 task deploy:staging

# Preview a database copy
DRY_RUN=1 task db:copy:dev-to-staging

# Preview volume removal
DRY_RUN=1 task stop:dev:volumes
```

### Confirmation Prompts

Destructive tasks require interactive confirmation before proceeding:

- All `db:reset:*` tasks
- All `stop:*:volumes` tasks
- `deploy:prod`
- `stop:scenario` and `stop:scenario:all`
- All `db:copy:*` tasks

### Other Safety Flags

| Flag | Purpose |
|------|---------|
| `RESET=1` | Tear down before starting (e.g., `RESET=1 task start:dev:db`) |
| `FORCE=1` | Required for prod-level destructive operations |
| `ALL=1` | Include system tags in cleanup operations |

---

## Task Commands Reference

### Branching (git:*)

| Command | Description |
|---------|-------------|
| `task git:feature -- <name>` | Create feature branch from develop |
| `task git:fix -- <name>` | Create fix branch from develop |
| `task git:hotfix -- <name>` | Create hotfix branch from main |

### Pull Requests (git:pr:*)

| Command | Description |
|---------|-------------|
| `task git:pr` | Push and create draft PR (auto-detects target) |
| `task git:pr:publish` | Push and create ready PR |
| `task git:pr:ready` | Mark draft as ready for review |
| `task git:pr:checks` | Show CI status |
| `task git:pr:merge` | Squash and merge (shows next steps) |
| `task git:pr:view` | Open PR in browser |

### Release (git:release:*)

| Command | Description |
|---------|-------------|
| `task git:release:prepare` | Create release PR (develop → main) |
| `task git:release:ready` | Mark release PR as ready |
| `task git:release:merge` | Merge release PR (shows next steps) |
| `task git:release:tag -- v1.0.0` | Tag release on main |
| `task git:tags` | List all release tags |
| `task release -- v1.0.0` | Combo: tag + deploy to prod |

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | Start full dev environment (DB + backend + frontend) |
| `task start:dev:debug` | Start full stack with debugging |
| `task start:dev:db` | Start dev database only |
| `task start:dev:backend` | Start backend only |
| `task start:dev:backend:debug` | Start backend with debugger |
| `task start:dev:frontend` | Start frontend only |
| `task stop:dev` | Stop all dev services |

### Staging

| Command | Description |
|---------|-------------|
| `task deploy:staging` | Build from develop + deploy |
| `task deploy:staging:ref -- <ref>` | Build from git ref + deploy |
| `task deploy:staging:dirty` | Build from working directory + deploy |
| `task start:staging` | Start staging (existing images) |
| `task stop:staging` | Stop staging stack |

### Scenario

| Command | Description |
|---------|-------------|
| `task start:scenario` | Local code + Docker DB + live reload |
| `task start:scenario:ref -- <ref>` | Build from git ref + deploy all-Docker |
| `task stop:scenario` | Stop one scenario instance |
| `task stop:scenario:all` | Stop ALL running scenario instances |
| `task db:seed:scenario` | Seed scenario database |
| `task db:reset:scenario` | Reset scenario database (truncate + reseed) |
| `task logs:scenario` | Tail scenario logs |

All scenario commands accept `SCENARIO=<name>` to target a specific instance and `SEED_DIR=path/to/scenario/` to overlay scenario data.

### Production

| Command | Description |
|---------|-------------|
| `task deploy:prod -- v1.2.0` | Deploy to local prod |
| `task start:prod` | Start prod (existing images) |
| `task stop:prod` | Stop prod stack |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate:dev` | Run migrations on dev |
| `task db:migrate:staging` | Run migrations on staging |
| `task db:migrate:prod` | Run migrations on prod |
| `task db:seed:dev` | Seed dev database |
| `task db:seed:staging` | Seed staging database |
| `task db:reset:dev` | ⚠️ Reset dev database (`DRY_RUN=1` to preview) |
| `task db:reset:staging` | ⚠️ Reset staging database (`DRY_RUN=1` to preview) |
| `task db:reset:prod` | 🚨 Reset prod database |
| `task db:copy:dev-to-staging` | Copy dev → staging (`DRY_RUN=1` to preview) |
| `task db:copy:staging-to-dev` | Copy staging → dev with migrations |
| `task db:copy:staging-to-prod` | ⚠️ Copy staging → prod |
| `task db:copy -- <src> <dst>` | Generic copy between any envs |
| `task db:status:dev` | Show migration status |
| `task db:check:dev` | Validate migration health |

### Build

| Command | Description |
|---------|-------------|
| `task build:staging` | Build images from develop |
| `task build:prod -- v1.0.0` | Build images from main |
| `task build:ref -- <ref>` | Build from any git ref |
| `task build:dirty` | Build from working directory |
| `task build:list` | List all Docker images |
| `task build:clean` | Remove old/dangling images |
| `task build:clean:all` | ⚠️ Remove ALL images (`DRY_RUN=1` to preview) |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests |
| `task test:unit` | Full unit test suite |
| `task test:unit:backend` | Backend unit + API tests |
| `task test:unit:frontend` | Frontend type check + build |
| `task test:int` | All integration tests |
| `task test:int:full` | Full cycle (setup → test → cleanup) |
| `task test:e2e` | End-to-end tests |
| `task test:ci` | Simulate CI locally via Act |

### Utilities

| Command | Description |
|---------|-------------|
| `task install` | Install all dependencies |
| `task status` | Show running containers |
| `task logs:dev` | View dev logs |
| `task logs:staging` | View staging logs |
| `task help` | Show quick reference |

---

## Port Reference

| Service | Dev | Scenario (default) | Staging | Prod |
|---------|-----|---------------------|---------|------|
| PostgreSQL | 5432 | 5435 | 5433 | 5434 |
| Backend | 8000 | 8002 | 8001 | 8080 |
| Frontend | 5173 | 3002 | 3001 | 3000 |
| Debugger | 5678 | - | - | - |

### Scenario Port Allocation

Each scenario gets a **deterministic port offset** derived from a hash of its name (`cksum % 9999 + 1`), added to the base ports (DB=5435, API=8002, WEB=3002).

- **`default`** → always offset 0 (ports 5435/8002/3002)
- **Named scenarios** → hash of name (e.g. `fr_tax` → offset derived from `printf '%s' "fr_tax" | cksum`)
- **Override** → pass `PORT_OFFSET=N` to force a specific offset

Ports are stable: adding or removing scenarios never changes other scenarios' ports.

Run `task scenarios` to see all current assignments:

```bash
task scenarios
# Name                                Offset  DB     API    WEB    Status
# ──────────────────────────────────  ──────  ─────  ─────  ─────  ──────────
# default                                  0  5435   8002   3002   —
# fr_tax                                3980  9415   11982  6982   —
# spinoff                              4344  9779   12346  7346   —
# ...
```

The hash logic lives in `.taskfiles/scenario_ports.sh`.

For unlisted scenarios (no seed directory), pass `PORT_OFFSET=N` explicitly:

---

## Troubleshooting

### Database connection failed

```bash
# Check if dev database is running
docker ps | grep trades_db_dev

# Start it
task start:dev:db
```

### Port already in use

```bash
# Find what's using the port
lsof -i :8000

# Kill the process
kill -9 <PID>
```

### Docker images not found

```bash
# List available images
task build:list

# Build them
task build:staging       # For staging (from develop)
task build:prod -- v1.0.0  # For prod (from main)
```

### Reset everything

```bash
# Stop all services
task stop:dev
task stop:staging
task stop:prod

# Remove data (⚠️ destructive — prompts for confirmation)
task stop:dev:volumes
task stop:staging:volumes

# Preview first with DRY_RUN
DRY_RUN=1 task stop:dev:volumes
```
