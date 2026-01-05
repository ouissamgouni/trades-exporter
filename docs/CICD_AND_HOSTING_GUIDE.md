# CI/CD and Environment Management Guide

## Overview

This document outlines strategies for setting up test/production environments and CI/CD pipelines for the trades-exporter application.

---

## 1. Local Test/Prod Environment Setup

### Current Setup
You already have a good foundation with Docker Compose:
- **Test DB**: `trades_db_test` on port 5433
- **Prod DB**: `trades_db` on port 5432

### Enhanced Docker Compose for Full Stack

```yaml
# docker-compose.yml - Enhanced version
services:
  # ============ PRODUCTION ============
  postgres:
    image: postgres:16-alpine
    container_name: trades-exporter-db
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-trades_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-trades_password}
      POSTGRES_DB: ${POSTGRES_DB:-trades_db}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-trades_user}"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build: ./backend
    container_name: trades-exporter-backend
    environment:
      - TEST_MODE=false
      - POSTGRES_HOST=postgres
      - POSTGRES_PORT=5432
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./backend:/app
    command: uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

  frontend:
    build: ./frontend
    container_name: trades-exporter-frontend
    ports:
      - "3000:3000"
    depends_on:
      - backend
    volumes:
      - ./frontend:/app
      - /app/node_modules

  # ============ TEST ENVIRONMENT ============
  postgres_test:
    image: postgres:16-alpine
    container_name: trades-exporter-db-test
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-trades_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-trades_password}
      POSTGRES_DB: ${POSTGRES_DB_TEST:-trades_db_test}
    ports:
      - "${POSTGRES_TEST_PORT:-5433}:5432"
    volumes:
      - postgres_test_data:/var/lib/postgresql/data

  backend_test:
    build: ./backend
    container_name: trades-exporter-backend-test
    environment:
      - TEST_MODE=true
      - POSTGRES_HOST=postgres_test
      - POSTGRES_PORT=5432
    ports:
      - "8001:8000"
    depends_on:
      - postgres_test
    profiles:
      - test

volumes:
  postgres_data:
  postgres_test_data:
```

### Usage Commands

```bash
# Start production environment
docker compose up -d postgres backend frontend

# Start test environment
docker compose --profile test up -d postgres_test backend_test

# Run all tests
docker compose --profile test run backend_test pytest

# Switch frontend to test backend
VITE_API_URL=http://localhost:8001 npm run dev
```

---

## 2. GitHub Actions CI/CD (FREE)

GitHub Actions provides **2,000 free minutes/month** for public repos and **500 minutes/month** for private repos.

### Basic CI Pipeline

Create `.github/workflows/ci.yml`:

```yaml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  # ========== BACKEND TESTS ==========
  backend-tests:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: trades_user
          POSTGRES_PASSWORD: trades_password
          POSTGRES_DB: trades_db_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: 'pip'
          cache-dependency-path: backend/requirements.txt
      
      - name: Install dependencies
        working-directory: backend
        run: |
          python -m venv .venv
          .venv/bin/pip install -r requirements.txt
      
      - name: Run tests
        working-directory: backend
        env:
          TEST_MODE: "true"
          POSTGRES_HOST: localhost
          POSTGRES_PORT: 5432
          POSTGRES_USER: trades_user
          POSTGRES_PASSWORD: trades_password
          POSTGRES_DB_TEST: trades_db_test
        run: .venv/bin/python -m pytest -v --tb=short

  # ========== FRONTEND TESTS ==========
  frontend-tests:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json
      
      - name: Install dependencies
        working-directory: frontend
        run: npm ci
      
      - name: Type check
        working-directory: frontend
        run: npm run type-check || true  # Add type-check script
      
      - name: Build
        working-directory: frontend
        run: npm run build
      
      - name: Run tests
        working-directory: frontend
        run: npm test || true  # If you have tests

  # ========== LINT & FORMAT ==========
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      
      - name: Install linters
        run: pip install ruff black
      
      - name: Run Ruff
        working-directory: backend
        run: ruff check . || true
      
      - name: Check Black formatting
        working-directory: backend
        run: black --check . || true
```

### CD Pipeline (Deploy on merge to main)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: [backend-tests, frontend-tests]  # Wait for CI
    
    steps:
      - uses: actions/checkout@v4
      
      # Option 1: Deploy to Render
      - name: Deploy to Render
        env:
          RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
          RENDER_SERVICE_ID: ${{ secrets.RENDER_SERVICE_ID }}
        run: |
          curl -X POST "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys" \
            -H "Authorization: Bearer ${RENDER_API_KEY}"
      
      # Option 2: Deploy to Railway
      - name: Deploy to Railway
        uses: bervProject/railway-deploy@main
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: trades-exporter
      
      # Option 3: Deploy to Fly.io
      - name: Deploy to Fly.io
        uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

---

## 3. Free Hosting Options

### 🥇 Recommended: Railway.app

**Free Tier**: $5 credit/month (enough for small apps)

**Pros**:
- Easy PostgreSQL provisioning
- Auto-deploy from GitHub
- Good DX with railway CLI
- Environment variables management
- Supports Docker

**Setup**:
```bash
# Install Railway CLI
brew install railway

# Login and init
railway login
railway init

# Deploy
railway up
```

**railway.toml**:
```toml
[build]
builder = "dockerfile"

[deploy]
numReplicas = 1
healthcheckPath = "/health"
healthcheckTimeout = 100

[[services]]
name = "backend"
port = 8000

[[services]]
name = "frontend"  
port = 3000
```

---

### 🥈 Render.com

**Free Tier**: 
- Web services: 750 hours/month
- PostgreSQL: Free tier available

**Pros**:
- Native PostgreSQL support
- Auto-deploy from GitHub
- Free SSL
- Good documentation

**render.yaml** (Infrastructure as Code):
```yaml
services:
  # Backend API
  - type: web
    name: trades-exporter-api
    env: python
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn api.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: POSTGRES_HOST
        fromDatabase:
          name: trades-db
          property: host
      - key: POSTGRES_USER
        fromDatabase:
          name: trades-db
          property: user
      - key: POSTGRES_PASSWORD
        fromDatabase:
          name: trades-db
          property: password
      - key: POSTGRES_DB
        fromDatabase:
          name: trades-db
          property: database
      - key: TEST_MODE
        value: "false"

  # Frontend
  - type: web
    name: trades-exporter-frontend
    env: static
    buildCommand: npm install && npm run build
    staticPublishPath: ./dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html

databases:
  - name: trades-db
    plan: free
```

---

### 🥉 Fly.io

**Free Tier**: 
- 3 shared-cpu VMs
- 3GB persistent storage
- 160GB outbound bandwidth

**Pros**:
- Global deployment (edge locations)
- Good for low-latency apps
- PostgreSQL support
- Great CLI

**fly.toml** (Backend):
```toml
app = "trades-exporter-api"
primary_region = "cdg"  # Paris

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  TEST_MODE = "false"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

[[services]]
  protocol = "tcp"
  internal_port = 8080

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

---

### Other Free Options

| Platform | Free Tier | Best For |
|----------|-----------|----------|
| **Vercel** | Unlimited static, 100GB bandwidth | Frontend only |
| **Netlify** | 100GB bandwidth, 300 build min | Frontend only |
| **Supabase** | 500MB DB, 2GB bandwidth | PostgreSQL + Auth |
| **PlanetScale** | 5GB storage, 1B reads | MySQL |
| **Neon** | 3GB storage, 100 compute hours | PostgreSQL (serverless) |
| **Koyeb** | 2 nano instances | Full stack |

---

## 4. Recommended Architecture

### Local Development
```
┌─────────────────────────────────────────────────────────┐
│                    LOCAL MACHINE                         │
├─────────────────────┬───────────────────────────────────┤
│   TEST ENVIRONMENT  │      PROD-LIKE ENVIRONMENT        │
│                     │                                   │
│  ┌───────────────┐  │  ┌───────────────┐               │
│  │ postgres_test │  │  │   postgres    │               │
│  │  (port 5433)  │  │  │  (port 5432)  │               │
│  └───────────────┘  │  └───────────────┘               │
│         ▲           │          ▲                        │
│         │           │          │                        │
│  ┌──────┴────────┐  │  ┌───────┴───────┐               │
│  │ Backend Test  │  │  │    Backend    │               │
│  │ TEST_MODE=1   │  │  │  TEST_MODE=0  │               │
│  │  (port 8001)  │  │  │  (port 8000)  │               │
│  └───────────────┘  │  └───────────────┘               │
│                     │          ▲                        │
│                     │          │                        │
│                     │  ┌───────┴───────┐               │
│                     │  │   Frontend    │               │
│                     │  │  (port 3000)  │               │
│                     │  └───────────────┘               │
└─────────────────────┴───────────────────────────────────┘
```

### Production (Cloud)
```
┌─────────────────────────────────────────────────────────┐
│                    GITHUB                                │
│  ┌─────────────┐                                        │
│  │    main     │ ──push──▶ GitHub Actions               │
│  │   branch    │            │                           │
│  └─────────────┘            ▼                           │
│                    ┌─────────────────┐                  │
│                    │   CI Pipeline   │                  │
│                    │  - Run tests    │                  │
│                    │  - Build        │                  │
│                    │  - Lint         │                  │
│                    └────────┬────────┘                  │
│                             │ success                   │
│                             ▼                           │
│                    ┌─────────────────┐                  │
│                    │   CD Pipeline   │                  │
│                    │  - Deploy       │                  │
│                    └────────┬────────┘                  │
└─────────────────────────────┼───────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              RAILWAY / RENDER / FLY.IO                   │
│                                                          │
│  ┌───────────────┐      ┌───────────────┐              │
│  │  PostgreSQL   │◀────▶│    Backend    │              │
│  │   (managed)   │      │   (uvicorn)   │              │
│  └───────────────┘      └───────┬───────┘              │
│                                 │ API                   │
│                                 ▼                       │
│                         ┌───────────────┐              │
│                         │   Frontend    │              │
│                         │   (static)    │              │
│                         └───────────────┘              │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Quick Start Guide

### Step 1: Set up GitHub Actions
```bash
mkdir -p .github/workflows
# Copy the ci.yml content above
```

### Step 2: Choose a hosting platform
I recommend **Railway** for the easiest setup:

```bash
# Install CLI
brew install railway

# Login
railway login

# Initialize project
cd /path/to/trades-exporter
railway init

# Add PostgreSQL
railway add --name postgres

# Set environment variables
railway variables set POSTGRES_HOST=\${{Postgres.PGHOST}}
railway variables set POSTGRES_USER=\${{Postgres.PGUSER}}
railway variables set POSTGRES_PASSWORD=\${{Postgres.PGPASSWORD}}
railway variables set POSTGRES_DB=\${{Postgres.PGDATABASE}}
railway variables set POSTGRES_PORT=\${{Postgres.PGPORT}}
railway variables set TEST_MODE=false

# Deploy
railway up
```

### Step 3: Connect GitHub for auto-deploy
1. Go to Railway dashboard
2. Connect your GitHub repo
3. Enable automatic deployments on push to `main`

---

## 6. Environment Variables Management

### For Local Development
Use `.env` file (already in place)

### For GitHub Actions
Add secrets in GitHub repo settings:
- `RENDER_API_KEY`
- `RAILWAY_TOKEN`
- `FLY_API_TOKEN`
- Any API keys needed for tests

### For Production Hosting
Each platform has its own way:
- **Railway**: `railway variables set KEY=value`
- **Render**: Dashboard → Environment Variables
- **Fly.io**: `fly secrets set KEY=value`

---

## Summary

| Component | Local | CI | Production |
|-----------|-------|----|-----------| 
| Database | Docker Compose | GitHub Actions Service | Railway/Render PostgreSQL |
| Backend | uvicorn (local) | pytest in CI | Deployed container |
| Frontend | Vite dev server | npm build in CI | Static hosting |
| Secrets | .env file | GitHub Secrets | Platform secrets |

The recommended stack for your use case:
1. **CI/CD**: GitHub Actions (free 2000 min/month)
2. **Hosting**: Railway ($5 free credit) or Render (free tier)
3. **Database**: Managed PostgreSQL from same provider
