# UI Design: Unified Setup Section

## Problem

Previously, setup-related functionality was scattered across 5 separate tabs:

- 👤 Accounts
- 🔌 Connectors
- 💰 Assets
- 🔧 Raw Assets
- 🔧 Raw Accounts

This created tab clutter and made the setup process less intuitive.

## Solution: Unified Setup View

### Design Approach

A single **⚙️ Setup** tab with a **two-column layout**:

```
┌─────────────────────────────────────────────────────────┐
│  Setup & Configuration              [85% Complete]      │
│  Configure your accounts, connectors, and assets        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌───────────────────────────────┐   │
│  │   Sidebar    │  │      Content Area             │   │
│  │              │  │                               │   │
│  │ ┌──────────┐ │  │  [Active Component Content]   │   │
│  │ │Accounts ✓│ │  │                               │   │
│  │ └──────────┘ │  │                               │   │
│  │              │  │                               │   │
│  │ ┌──────────┐ │  │                               │   │
│  │ │Connectors│ │  │                               │   │
│  │ └──────────┘ │  │                               │   │
│  │              │  │                               │   │
│  │ ┌──────────┐ │  │                               │   │
│  │ │Assets ⚠ │  │  │                               │   │
│  │ └──────────┘ │  │                               │   │
│  │              │  │                               │   │
│  │ ┌──────────┐ │  │                               │   │
│  │ │Raw Assets│ │  │                               │   │
│  │ └──────────┘ │  │                               │   │
│  │              │  │                               │   │
│  │ ┌──────────┐ │  │                               │   │
│  │ │Raw Accts │ │  │                               │   │
│  │ └──────────┘ │  │                               │   │
│  │              │  │                               │   │
│  └──────────────┘  └───────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Key Features

#### 1. **Progress Indicator**

- Overall completion percentage badge in header
- Shows setup progress at a glance

#### 2. **Left Sidebar Navigation**

- Lists all setup sections vertically
- Each section shows:
  - **Name** (e.g., "Accounts")
  - **Status icon** (✓ complete, ⚠ incomplete)
  - **Brief description** (e.g., "Connect and manage your trading accounts")
- Active section highlighted with blue background
- Click to navigate between sections

#### 3. **Right Content Area**

- Displays the selected component
- Full width for proper data display
- Same components as before (AccountsManagement, ConnectorsManager, etc.)

#### 4. **Status Tracking**

The setup status endpoint (`/api/config/setup-status`) provides:

- `accounts_connected`: Are accounts configured?
- `connectors_configured`: Are connectors set up?
- `assets_mapped`: Are assets mapped?
- `base_currency_set`: Is base currency configured?

### Benefits

✅ **Reduced Tab Clutter**: From 13 tabs down to 9 tabs  
✅ **Better Organization**: All setup items in one logical section  
✅ **Clear Progress**: Visual indicators show what's complete  
✅ **Intuitive Navigation**: Sidebar makes it easy to jump between setup steps  
✅ **Scalable**: Easy to add new setup sections without adding more tabs  
✅ **Contextual**: Descriptions help users understand what each section does  

### Tab Structure (After Implementation)

**Core Workflow Tabs:**

1. 📥 Inbox - Pending transactions requiring review
2. ✅ Reviewed - Reviewed transactions
3. 📋 All Transactions - Complete transaction history
4. 📦 Bundles - Transaction bundles
5. 🔄 Sync - Data synchronization
6. ➕ Add - Manual transaction entry
7. 📊 P&L - Profit & Loss calculations

**Configuration Tabs:**
8. ⚙️ Setup - Unified setup section (NEW)
9. 📈 Prices - Price data management

### Implementation Details

**Component**: `UnifiedSetupView.tsx`

- Uses Chakra UI for consistent styling
- State management for active section
- Fetches setup status on mount
- Dynamically renders selected component

**Sections Included**:

1. **Accounts** - AccountsManagement component
2. **Connectors** - ConnectorsManager component
3. **Asset Mapping** - AssetsEditor component
4. **Raw Assets** - RawAssetsEditor component
5. **Raw Accounts** - RawAccountsEditor component

### Future Enhancements

1. **Setup Wizard Mode**: Step-by-step guided setup for new users
2. **Quick Actions**: Buttons in sidebar for common tasks (e.g., "Add Account")
3. **Validation Messages**: Show specific issues preventing completion
4. **Onboarding**: First-time user tutorial highlighting setup flow
5. **Search**: Filter setup sections by keyword

---

## Review Workflow Design

### Complete User Workflow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           USER WORKFLOW                                     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SETUP          2. SYNC/ADD        3. REVIEW           4. P&L           │
│  ┌──────────┐     ┌──────────┐      ┌──────────┐       ┌──────────┐       │
│  │ Accounts │     │ Run Sync │      │ Inbox    │       │ Configure│       │
│  │ Connect. │ --> │ Or Add   │ -->  │ Review   │ -->   │ Base Ccy │       │
│  │ Assets   │     │ Manually │      │ Approve  │       │ Run Calc │       │
│  │ Base Ccy │     │          │      │ Bundles  │       │          │       │
│  └──────────┘     └──────────┘      └──────────┘       └──────────┘       │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### 📥 Inbox Tab

**Purpose:** Review pending transactions and suggested bundles

**Features:**

1. **Stats Dashboard** - Quick overview cards showing:
   - Total pending transactions
   - Transactions needing taxability review (warning highlight)
   - Number of bundle suggestions
   - Breakdown by source

2. **Bundle Suggestions Section**
   - Cards showing suggested bundles with pattern, confidence, reason
   - Quick actions: [Accept] [Dismiss]

3. **Pending Transactions Table**
   - Row highlighting by direction (green=inflow, red=outflow)
   - Bulk selection with checkboxes
   - Bulk actions: ✓ Review, 💰 Taxable, ✓ Non-Taxable, ✕ Exclude
   - Expandable details (price, fee, addresses)

### ✅ Reviewed Tab

**Purpose:** View all reviewed transactions and bundles

**Features:**

1. **Stats Dashboard** - Overview cards:
   - Total reviewed transactions
   - Total bundles
   - Taxable/Non-taxable/Unknown counts

2. **Sub-tabs:**
   - **Transactions** - Table with "Unreview" option
   - **Bundles** - Card grid showing all bundles

### 📊 P&L Tab

**Prerequisites:**

- ✅ Base currency configured
- ✅ All transactions reviewed (Inbox empty)
- ✅ Taxability set for all transactions

**Configuration:**

- Lot method: FIFO, LIFO, HIFO
- Base currency selection
- Tolerance settings

**Output:**

- Summary cards (gains, losses, net)
- Realized P&L table
- Warnings for issues
- Export options
