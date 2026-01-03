#!/bin/bash
# Script to run database migrations on both prod and test databases
#
# Usage:
#   ./scripts/run_migrations.sh           # Run on both databases
#   ./scripts/run_migrations.sh --prod    # Run on production only  
#   ./scripts/run_migrations.sh --test    # Run on test only
#   ./scripts/run_migrations.sh --dry-run # Show what would be done

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Parse arguments
RUN_PROD=false
RUN_TEST=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --prod)
            RUN_PROD=true
            shift
            ;;
        --test)
            RUN_TEST=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If neither specified, run both
if [ "$RUN_PROD" = false ] && [ "$RUN_TEST" = false ]; then
    RUN_PROD=true
    RUN_TEST=true
fi

echo "================================"
echo "Database Migration Runner"
echo "================================"

# Change to project root
cd "$(dirname "$0")/.."

# Function to run migration
run_migration() {
    local db_type=$1
    local testing_flag=$2
    
    echo ""
    echo -e "${GREEN}Running migration on $db_type database...${NC}"
    
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}  [DRY RUN] Would run: TEST_MODE=$testing_flag .venv/bin/python -m alembic upgrade head${NC}"
        return
    fi
    
    # Set TEST_MODE flag (alembic env.py checks TEST_MODE)
    TEST_MODE=$testing_flag .venv/bin/python -m alembic upgrade head
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}  ✓ $db_type migration completed successfully${NC}"
    else
        echo -e "${RED}  ✗ $db_type migration failed${NC}"
        exit 1
    fi
}

# Run production migration
if [ "$RUN_PROD" = true ]; then
    run_migration "PRODUCTION" "0"
fi

# Run test migration
if [ "$RUN_TEST" = true ]; then
    run_migration "TEST" "1"
fi

echo ""
echo "================================"
echo -e "${GREEN}All migrations completed!${NC}"
echo "================================"

# Optionally run data migration
echo ""
read -p "Do you want to run the data migration script as well? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}[DRY RUN] Would run data migration${NC}"
    else
        if [ "$RUN_PROD" = true ]; then
            echo -e "${GREEN}Running data migration on PRODUCTION...${NC}"
            python scripts/migrate_to_groups.py
        fi
        if [ "$RUN_TEST" = true ]; then
            echo -e "${GREEN}Running data migration on TEST...${NC}"
            python scripts/migrate_to_groups.py --test
        fi
    fi
fi
