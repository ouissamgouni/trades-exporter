# Trades Exporter

Cryptocurrency transaction management and review system with FastAPI backend and Next.js frontend.

## Features

- **Transaction Management**: Import, normalize, and review crypto transactions from multiple exchanges
- **Smart Grouping**: AI-powered suggestions for grouping related transactions
- **REST API**: FastAPI backend with Pydantic validation
- **Web Interface**: React/Next.js frontend for easy transaction review
- **Multi-Exchange Support**: Binance, MEXC, and extensible architecture

## Quick Start

### Option 1: Automated Setup

```bash
chmod +x setup.sh
./setup.sh
```

### Option 2: Manual Setup

**Backend:**

```bash
# Create and activate virtual environment
cd backend
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start API server (from project root)
cd ..
uvicorn backend.api.main:app --reload
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev
```

**Access:**

- Frontend: <http://localhost:3000>
- API Docs: <http://localhost:8000/docs>
- API: <http://localhost:8000>

## Project Structure

```
trades-exporter/
├── backend/                    # Python backend (self-contained)
│   ├── api/                    # FastAPI application
│   │   ├── main.py             # App entry point
│   │   ├── schemas.py          # API schemas
│   │   └── routes/             # Endpoint handlers
│   ├── config/                 # Configuration files
│   │   └── settings.yaml
│   ├── connectors/             # Exchange connectors
│   ├── core/                   # Business logic
│   ├── db/                     # Database layer
│   │   ├── alembic/            # Migrations
│   │   ├── models.py           # SQLModel models
│   │   └── repositories/       # Data access
│   ├── services/               # Business services
│   │   ├── pnl/                # P&L calculation engine
│   │   └── pipeline/           # Transaction processing pipeline
│   ├── tests/                  # Test suite
│   ├── scripts/                # Utility scripts
│   ├── data/                   # Data files
│   │   ├── input/              # Import sources
│   │   └── output/             # Export destinations
│   ├── .env                    # Environment config
│   ├── pytest.ini              # Test config
│   ├── requirements.txt        # Python dependencies
│   └── alembic.ini             # Migration config
│
├── frontend/                   # React frontend
│   ├── src/
│   ├── public/
│   └── package.json
│
├── docs/                       # Documentation
├── docker-compose.yml          # Container orchestration
└── README.md
```

## Usage

### Import Transactions

```bash
python -m trade_exporter.runners.run_all
```

### API Endpoints

- `GET /transactions` - List transactions with filters
- `PATCH /transactions/{id}` - Update transaction
- `GET /groups` - List transaction groups
- `POST /groups` - Create group
- `GET /groups/pending/suggestions` - AI grouping suggestions

### Web Interface

1. **Transactions Tab**: View and edit all transactions inline
   - Filter by status (pending/reviewed) and source (exchange)
   - Edit transaction type, status, notes, taxable flag
   - Inline save functionality

2. **Groups Tab**: Manage transaction groups
   - View AI-powered grouping suggestions
   - Create custom groups
   - Add/remove transactions from groups

3. **Assets Tab**: (Coming soon) Configure asset metadata

4. **Prices Tab**: (Coming soon) View current prices

## Testing

```bash
# Run all tests
pytest

# Run API tests only
pytest tests/api/

# Run with coverage
pytest --cov=trade_exporter
```

## Development

This project uses:

- **Backend**: Python 3.11+, FastAPI, Pydantic v2, SQLite
- **Frontend**: Next.js 14, React 18, TypeScript
- **Testing**: pytest, FastAPI TestClient

## Configuration

Edit `trade_exporter/config/settings.yaml` for general settings and `asset_map.yaml` for asset mappings.
