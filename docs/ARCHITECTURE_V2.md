# Architecture V2: Simplified Transaction + Bundle Model

## Overview

This document outlines a simplified architecture that clearly separates:

1. **Transactions** - Individual economic events (with their legs)
2. **Bundles** - User-created groupings for P&L purposes
3. **AI Suggestions** - Ephemeral recommendations (not persisted until accepted)

## Core Design Principles

### Key Insight: Leg Expansion ≠ Grouping

**Current confusion**: We use "groups" for two different concepts:

1. Container for auto-expanded legs (1 tx → N legs)
2. User-created bundles (N txs → 1 P&L unit)

**Solution**: Legs are just enrichment of a transaction, NOT a separate group.

```
WRONG (current):
  Transaction → creates → Group → contains → Legs
  
RIGHT (proposed):
  Transaction → has → Legs (directly)
  Bundle → contains → Transactions (user-created)
```

## Data Model

### Option A: Legs as Separate Rows (Minimal Change)

Keep transactions as rows, but use `parent_transaction_id` to link legs to their source.
No need for a "groups" table for auto-expansion.

```sql
-- Main transaction table (unchanged structure)
normalized_transactions:
  - id, platform, type, date_time, ...
  - status: 'pending' | 'reviewed' | 'excluded' (NEW)
  - bundle_id: FK → bundles (NULL = standalone) (NEW)
  - parent_transaction_id: FK → self (for legs)
  - leg_type: 'cost' | 'proceeds' | 'acquired' | 'disposed' | 'fee'
  - taxability: 'taxable' | 'non_taxable' | 'unknown' (NEW)

-- User-created bundles only (replaces current groups usage)
bundles:
  - id
  - label: str
  - pattern: 'transfer' | 'migration' | 'dca' | 'custom'
  - notes: text
  - created_at: datetime
  - taxability_override: 'taxable' | 'non_taxable' | NULL (user can override)
```

### Option B: Legs as JSON Column (Simpler Queries)

Store legs directly on transaction as JSON - no separate rows.

```sql
normalized_transactions:
  - id, platform, type, date_time, ...
  - status: 'pending' | 'reviewed' | 'excluded'
  - bundle_id: FK → bundles (NULL = standalone)
  - legs: JSON [
      {"leg_type": "disposed", "asset": "BTC", "quantity": 1.5, "direction": "outflow"},
      {"leg_type": "acquired", "asset": "USD", "quantity": 45000, "direction": "inflow"},
      {"leg_type": "fee", "asset": "BTC", "quantity": 0.001, "direction": "outflow"}
    ]
  - taxability: 'taxable' | 'non_taxable' | 'unknown'

bundles:
  - id, label, pattern, notes, created_at
  - taxability_override
```

### Recommendation: Option A (Legs as Rows)

Reasons:

- Already have `parent_transaction_id` and `leg_type` columns
- Allows SQL queries on legs (filtering, aggregation)
- Matches P&L engine's current expectation
- Minimal migration from current state

## Transaction Status Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TRANSACTION LIFECYCLE                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   Sync        →    Normalize    →    Expand Legs    →    Status      │
│   (Raw)            (Pipeline)        (Pipeline)          = 'pending'  │
│                                                                       │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │  INBOX: status = 'pending'                                   │    │
│   │  • Transaction has legs (pre-expanded)                       │    │
│   │  • AI suggestions shown (but NOT persisted)                  │    │
│   │  • User actions: Review | Bundle | Exclude                   │    │
│   └─────────────────────────────────────────────────────────────┘    │
│            │                    │                    │                │
│            ▼                    ▼                    ▼                │
│   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐          │
│   │  REVIEWED   │      │   BUNDLED   │      │  EXCLUDED   │          │
│   │  (standalone)│      │ (in bundle)│      │  (ignored)  │          │
│   │  status=     │      │  bundle_id │      │  status=    │          │
│   │  'reviewed'  │      │  IS NOT    │      │  'excluded' │          │
│   │  bundle_id   │      │  NULL      │      │             │          │
│   │  IS NULL     │      │            │      │             │          │
│   └─────────────┘      └─────────────┘      └─────────────┘          │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

## Bundle vs Auto-Expansion

| Aspect | Auto-Expanded Legs | User Bundle |
|--------|-------------------|-------------|
| Purpose | Enrich single tx with components | Group multiple tx for P&L |
| Storage | `parent_transaction_id` on child | `bundle_id` on parent |
| Creation | Automatic (pipeline) | Manual (user action) |
| Can modify | No (system generated) | Yes (user manages) |
| P&L unit | 1 transaction = 1 P&L event | N transactions = 1 P&L event |

## AI Suggestions

### Design: Ephemeral (Computed on Demand)

**Why not persist suggestions?**

1. They can be regenerated anytime
2. User might change criteria
3. Keeps DB clean
4. Avoids stale suggestions

**API Approach:**

```
GET /api/transactions/suggestions
  - Returns potential bundles based on current pending transactions
  - Pattern detection: transfers, DCA, migrations
  - Not stored in DB

POST /api/bundles
  - Create bundle from suggestion
  - Persists the bundle + links transactions
```

### Suggestion Service

```python
class BundleSuggestionService:
    """Generate bundle suggestions without persisting."""
    
    def get_suggestions(
        self,
        transactions: List[NormalizedTransaction],
    ) -> List[BundleSuggestion]:
        """
        Analyze transactions and suggest potential bundles.
        
        Returns:
            List of suggestions with:
            - pattern: 'transfer' | 'migration' | 'dca'
            - transaction_ids: list of IDs to group
            - confidence: 0.0-1.0
            - reason: explanation
        """
        suggestions = []
        suggestions.extend(self._detect_transfers(transactions))
        suggestions.extend(self._detect_dca_patterns(transactions))
        suggestions.extend(self._detect_migrations(transactions))
        return suggestions
```

## Taxability Flow

### When is Taxability Determined?

```
┌─────────────────────────────────────────────────────────────────────┐
│                       TAXABILITY LIFECYCLE                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. INITIAL (Pipeline)                                               │
│     └── Default based on transaction_type:                           │
│         • disposal → taxability = 'unknown' (needs review)           │
│         • acquisition → taxability = 'non_taxable' (usually)         │
│         • transfer → taxability = 'non_taxable'                      │
│                                                                      │
│  2. PATTERN DETECTION (Suggestions)                                  │
│     └── Suggest taxability based on detected pattern:                │
│         • Self-transfer → 'non_taxable'                              │
│         • Swap → 'taxable' (in most jurisdictions)                   │
│         • DCA buy → 'non_taxable'                                    │
│                                                                      │
│  3. USER REVIEW (Inbox)                                              │
│     └── User confirms or overrides taxability                        │
│         • Per-transaction: tx.taxability = 'taxable'                 │
│         • Per-bundle: bundle.taxability_override = 'non_taxable'     │
│                                                                      │
│  4. P&L CALCULATION (Runtime)                                        │
│     └── Uses final taxability value with config context:             │
│         • If bundle.taxability_override: use it                      │
│         • Else: use tx.taxability                                    │
│         • Base currency from PnlConfig affects interpretation        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Point: Taxability Doesn't Require P&L Config

Taxability is a **yes/no/unknown** flag per transaction. It means:

- "Should this transaction generate a taxable event?"

The **base currency** from P&L config affects **calculation**, not taxability:

- If base currency is USD, selling BTC for USD is taxable
- If base currency is EUR, the P&L is calculated in EUR

So taxability can be reviewed in Inbox **before** P&L config is set.

## UI Architecture

### Three Tabs (Simplified)

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Inbox (12)]  [Reviewed (45)]  [Bundles (3)]  [Excluded (2)]        │
├──────────────────────────────────────────────────────────────────────┤
```

### Tab 1: Inbox

```
┌──────────────────────────────────────────────────────────────────────┐
│  INBOX - New Transactions to Review                                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  💡 Suggested Bundle: Self-Transfer (2 txs, 95% confidence)          │
│     [Create Bundle] [Dismiss]                                         │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ ☐ SELL BTC → USD          2024-01-15    Binance     [Review ▼] │  │
│  │   └─ Legs: -1.5 BTC (disposed) +45,000 USD (proceeds) -0.001   │  │
│  │            BTC (fee)                                            │  │
│  │   └─ Taxability: ⚠️ Unknown [Taxable | Non-Taxable]            │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │ ☐ BUY ETH → USD           2024-01-16    Coinbase    [Review ▼] │  │
│  │   └─ Legs: -3,000 USD (cost) +1.2 ETH (acquired) -5 USD (fee)  │  │
│  │   └─ Taxability: ✓ Non-Taxable                                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Bulk Actions: [Mark Reviewed] [Create Bundle] [Exclude]              │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Tab 2: Reviewed (Standalone Transactions)

```
┌──────────────────────────────────────────────────────────────────────┐
│  REVIEWED - Standalone Transactions (not in bundles)                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Filter: [All Types ▼] [All Platforms ▼] [Taxable Only ☐]            │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ SELL BTC → USD          2024-01-15    Binance     💰 Taxable   │  │
│  │ BUY ETH → USD           2024-01-16    Coinbase    ✓ Non-Tax    │  │
│  │ ...                                                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Tab 3: Bundles

```
┌──────────────────────────────────────────────────────────────────────┐
│  BUNDLES - Grouped Transactions for P&L                               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 📦 BTC Self-Transfer           Pattern: transfer   Non-Taxable │  │
│  │    2 transactions, 2024-01-20                                   │  │
│  │    └─ -1.0 BTC (Binance) → +1.0 BTC (Ledger)                   │  │
│  │    [Edit] [Unbundle]                                            │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │ 📦 ETH DCA January          Pattern: dca          Non-Taxable  │  │
│  │    5 transactions, 2024-01-01 to 2024-01-31                     │  │
│  │    └─ Total: +5.0 ETH acquired, -15,000 USD cost               │  │
│  │    [Edit] [Unbundle]                                            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  [+ Create Bundle]                                                    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

## Migration Path

### Phase 1: Schema Changes (Alembic)

```python
# Migration 003: Add status and bundle support

def upgrade():
    # Add status column
    op.add_column('normalized_transactions', 
        sa.Column('status', sa.String(20), default='pending', index=True))
    
    # Add taxability column (if not exists)
    op.add_column('normalized_transactions',
        sa.Column('taxability', sa.String(20), default='unknown'))
    
    # Create bundles table (separate from groups)
    op.create_table('bundles',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('label', sa.String(255)),
        sa.Column('pattern', sa.String(50)),
        sa.Column('notes', sa.Text()),
        sa.Column('taxability_override', sa.String(20)),
        sa.Column('created_at', sa.DateTime(), default=utc_now),
    )
    
    # Add bundle_id FK to transactions
    op.add_column('normalized_transactions',
        sa.Column('bundle_id', sa.Integer(), sa.ForeignKey('bundles.id')))
```

### Phase 2: Data Migration

```python
def migrate_existing_data():
    """
    Migrate from current groups to new model.
    
    - Groups with single parent_transaction_id → No bundle needed (just legs)
    - Groups with multiple transactions → Create bundle
    """
    
    # Groups that are just leg containers (auto-expanded)
    # → Leave as is, legs are linked via parent_transaction_id
    
    # Groups that are user bundles (multiple source txs)
    # → Create bundle, link transactions
    
    for group in session.query(Group).all():
        member_txs = get_member_transactions(group)
        parent_txs = [tx for tx in member_txs if tx.parent_transaction_id is None]
        
        if len(parent_txs) > 1:
            # This is a real bundle (user-created or multi-tx pattern)
            bundle = Bundle(
                label=group.group_label,
                pattern=group.group_type,
            )
            session.add(bundle)
            session.flush()
            
            for tx in parent_txs:
                tx.bundle_id = bundle.id
```

### Phase 3: Remove Legacy

```python
# Migration 004: Remove legacy groups table (optional, can keep for history)

def upgrade():
    # Option 1: Drop groups table entirely
    # op.drop_table('group_members')
    # op.drop_table('groups')
    
    # Option 2: Rename for archival
    op.rename_table('groups', 'groups_archive')
    op.rename_table('group_members', 'group_members_archive')
```

## Implementation Order

1. **Add `status` and `taxability` columns** (Alembic migration)
2. **Create `bundles` table** (Alembic migration)  
3. **Add `bundle_id` FK to transactions** (Alembic migration)
4. **Update LegExpansionStage** to NOT create groups, just set parent_transaction_id
5. **Create BundleSuggestionService** (ephemeral suggestions)
6. **Update API routes** (separate transactions vs bundles endpoints)
7. **Update UI** (Inbox/Reviewed/Bundles tabs)
8. **Migrate existing data** (script)
9. **Deprecate/archive old groups table** (optional)

## Summary

| Question | Answer |
|----------|--------|
| Distinguish auto-expanded from bundles? | Yes - different mechanisms: `parent_transaction_id` vs `bundle_id` |
| Inbox contains auto-expanded? | Yes - transactions arrive with legs already expanded, status='pending' |
| Bundles contain suggestions? | No - suggestions are ephemeral until user accepts |
| When is taxability reviewed? | In Inbox - user confirms/overrides before marking reviewed |
| Does taxability need P&L config? | No - it's a yes/no flag. P&L config affects calculation, not taxability |
