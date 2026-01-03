import React from 'react';
import { TransactionsTable } from './TransactionsTable';

/**
 * InboxView - Shows pending transactions with bundle suggestions
 * 
 * This is a thin wrapper around TransactionsTable with:
 * - Workflow filter preset to "pending"
 * - Bundle suggestions enabled (shown in Bundles tab)
 * - Bundles tab enabled
 * - Filters hidden (inbox is specifically for pending items)
 */
export const InboxView: React.FC = () => {
    return (
        <TransactionsTable
            title="📥 Inbox"
            subtitle="Review pending transactions and accept bundle suggestions. Mark as reviewed or excluded."
            defaultWorkflowFilter="pending"
            showFilters={false}
            showBundles={true}
            showSuggestions={true}
        />
    );
};
