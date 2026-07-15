import React from 'react';
import { TransactionsView } from './TransactionsView';

/** InboxView — thin wrapper around TransactionsView with mode="inbox". */
export const InboxView: React.FC = () => <TransactionsView mode="inbox" />;
