# Development Workflow

This document describes the CI/CD workflow for the trades-exporter project.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Overview](#environment-overview)
- [Daily Development Workflow](#daily-development-workflow)
- [Branching Strategy](#branching-strategy)
- [Deployment](#deployment)
- [Testing](#testing)
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
| **Dev**     | Local development with VSCode debugging | 5432 | 8000 | 5173 |
| **Test**    | Containerized staging environment | 5433 | 8001 | 3001 |
| **Prod**    | Production (local or cloud) | 5434 | 8080 | 3000 |

### Dev Environment
- **Database**: Docker container
- **Backend**: Local Python process (debuggable)
- **Frontend**: Vite dev server (hot reload)

### Test Environment
- Fully containerized (Docker Compose)
- Built from `develop` branch
- Uses `:develop` tagged images

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
task feature my-feature-name
```

### 2. Start Development Environment

```bash
# Start database + backend (with debugger) + frontend
task start:dev:debug
```

Services running:
- Frontend: http://localhost:5173
- Backend API: http://localhost:8000
- Swagger Docs: http://localhost:8000/docs
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

# Push and create draft PR
task pr
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
| `feature/*` | develop | New features | `task feature <name>` |
| `fix/*` | develop | Bug fixes | `task fix <name>` |
| `hotfix/*` | main | Critical prod fixes | `task hotfix <name>` |

### Pull Request Flow

```bash
# Create feature branch
task feature my-feature

# ... make changes ...

# Create draft PR (to develop)
task pr

# When ready for review
task pr:ready

# View PR status
task pr:checks

# After approval, merge
task pr:merge
```

---

## Deployment

### Deploy to Test (Staging)

Test deployments are built from the `develop` branch:

```bash
# Build and deploy to test
task deploy:test:local
```

This will:
1. Checkout `develop` branch
2. Build Docker images tagged `:develop`
3. Start the test stack on ports 8001/3001

Access: http://localhost:3001

### Deploy to Production

Production deployments use tagged versions:

```bash
# 1. Merge develop → main (via PR)
task release:prepare

# 2. After PR is merged, create a tag
task release:tag v1.2.0

# 3. Deploy the tagged version
task deploy:prod:local v1.2.0
```

Access: http://localhost:3000

### Cloud Deployment (Render)

The project includes a `render.yaml` blueprint for automatic deployment to Render's free tier:

1. Create account at [render.com](https://render.com)
2. Connect your GitHub repository
3. Select "Blueprint" and Render will detect `render.yaml`
4. Set environment variables in dashboard:
   - `CORS_ORIGINS`: Your frontend URL
   - `VITE_API_URL`: Your backend URL

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
# Against dev database
task test:int:dev

# Against test stack
task deploy:test:local   # First deploy
task test:int:test       # Then run tests
```

### CI Simulation

Test the full CI pipeline locally:

```bash
task test:ci
```

---

## Task Commands Reference

### Branching

| Command | Description |
|---------|-------------|
| `task feature <name>` | Create feature branch from develop |
| `task fix <name>` | Create fix branch from develop |
| `task hotfix <name>` | Create hotfix branch from main |

### Development

| Command | Description |
|---------|-------------|
| `task start:dev` | Start dev database |
| `task start:dev:debug` | Start full stack with debugging |
| `task start:dev:backend` | Start backend only |
| `task start:dev:frontend` | Start frontend only |
| `task stop:dev` | Stop dev services |

### Database

| Command | Description |
|---------|-------------|
| `task db:migrate:dev` | Run migrations on dev |
| `task db:seed:dev` | Seed dev database |
| `task db:reset:dev` | ⚠️ Reset dev database |

### Build & Deploy

| Command | Description |
|---------|-------------|
| `task build:test` | Build images from develop |
| `task build:prod v1.0.0` | Build images from main |
| `task deploy:test:local` | Deploy to test environment |
| `task deploy:prod:local v1.0.0` | Deploy to local prod |
| `task build:list` | List all Docker images |

### Testing

| Command | Description |
|---------|-------------|
| `task test` | Quick unit tests |
| `task test:unit` | Full unit test suite |
| `task test:int:dev` | Integration tests (dev) |
| `task test:ci` | Simulate CI locally |

### Pull Requests

| Command | Description |
|---------|-------------|
| `task pr` | Push and create draft PR |
| `task pr:publish` | Push and create ready PR |
| `task pr:ready` | Mark draft as ready |
| `task pr:checks` | Show CI status |
| `task pr:merge` | Squash and merge |

### Release

| Command | Description |
|---------|-------------|
| `task release:prepare` | Create release PR (develop → main) |
| `task release:tag v1.0.0` | Tag and build production images |
| `task release:list` | List all version tags |

### Utilities

| Command | Description |
|---------|-------------|
| `task install` | Install all dependencies |
| `task status` | Show running containers |
| `task logs:dev` | View dev logs |
| `task help` | Show quick reference |

---

## Port Reference

| Service | Dev | Test | Prod |
|---------|-----|------|------|
| PostgreSQL | 5432 | 5433 | 5434 |
| Backend | 8000 | 8001 | 8080 |
| Frontend | 5173 | 3001 | 3000 |
| Debugger | 5678 | - | - |

---

## Troubleshooting

### Database connection failed

```bash
# Check if dev database is running
docker ps | grep trades_db_dev

# Start it
task start:dev
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
task build:test      # For test
task build:prod v1.0.0  # For prod
```

### Reset everything

```bash
# Stop all services
task clean:dev
task clean:test
task clean:prod

# Remove data (⚠️ destructive)
task clean:dev:volumes
```
