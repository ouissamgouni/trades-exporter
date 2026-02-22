import React from 'react';
import { TransactionsView } from './TransactionsView';

/** AllTransactionsView — thin wrapper around TransactionsView with mode="all". */
export const AllTransactionsView: React.FC = () => <TransactionsView mode="all" />;

export default AllTransactionsView;
