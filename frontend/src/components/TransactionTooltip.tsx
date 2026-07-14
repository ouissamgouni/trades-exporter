/**
 * TransactionTooltip - Shared hover tooltip for transaction details
 * 
 * Displays transaction details on hover with lazy loading.
 * Reusable across BundleTable, DataExplorerPanel, etc.
 */

import React, { useState } from 'react';
import { FiLoader } from 'react-icons/fi';
import { Tooltip } from './ui/tooltip';
import { Badge } from './ui/primitives';
import { API_URL } from '../types';
import { formatDateTimeLocale } from '../utils/dateUtils';
import { formatQuantity } from '../utils/numberUtils';
import { ValueDisplay } from './ValueDisplay';

// ============================================================================
// Types
// ============================================================================

interface TransactionDetail {
    transaction_id: number;
    date_time?: string;
    account_id?: number;
    account_name?: string;
    source?: string;
    source_transaction_type?: string;
    transaction_type?: string;
    direction?: string;
    from_account_id?: number;
    from_account_name?: string;
    to_account_id?: number;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;
    asset_id?: number;
    asset_symbol?: string;
    quantity?: number;
    price?: number;
    price_quote_asset_id?: number;
    price_quote_asset_symbol?: string;
    total?: number;
    fee?: number;
    fee_quote_asset_id?: number;
    fee_quote_asset_symbol?: string;
}

export interface TransactionTooltipProps {
    txId: number;
    children: React.ReactNode;
    baseCurrency?: string;
    onTransactionClick?: (txId: number) => void;
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Component
// ============================================================================

export const TransactionTooltip: React.FC<TransactionTooltipProps> = ({
    txId,
    children,
    baseCurrency = 'USD',
    onTransactionClick,
}) => {
    const [txData, setTxData] = useState<TransactionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);

    const fetchTransaction = async () => {
        if (hasFetched || loading) return;
        setLoading(true);
        setHasFetched(true);
        try {
            const response = await fetch(`${API_URL}/transactions/${txId}`);
            if (!response.ok) throw new Error('Failed to fetch');
            const data = await response.json();
            setTxData({
                transaction_id: data.id,
                date_time: data.date_time,
                account_id: data.account_id,
                account_name: data.account_name || '-',
                source: data.source,
                source_transaction_type: data.source_transaction_type,
                transaction_type: data.transaction_type,
                direction: data.direction,
                from_account_id: data.from_account_id,
                from_account_name: data.from_account_name,
                to_account_id: data.to_account_id,
                to_account_name: data.to_account_name,
                source_from_account: data.source_from_account,
                source_to_account: data.source_to_account,
                asset_id: data.asset_id,
                asset_symbol: data.linked_asset_symbol || data.source_asset_symbol,
                quantity: data.quantity,
                price: data.price,
                price_quote_asset_id: data.price_quote_asset_id,
                price_quote_asset_symbol: data.linked_price_quote_asset_symbol || data.source_price_quote_asset_symbol,
                total: data.total,
                fee: data.fee,
                fee_quote_asset_id: data.fee_quote_asset_id,
                fee_quote_asset_symbol: data.linked_fee_quote_asset_symbol || data.source_fee_quote_asset_symbol,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error');
        } finally {
            setLoading(false);
        }
    };

    const tooltipContent = (
        <div className="min-w-[250px] text-xs" onMouseEnter={fetchTransaction}>
            {loading ? (
                <div className="flex items-center gap-2">
                    <FiLoader className="animate-spin" />
                    <span className="text-slate-300">Loading...</span>
                </div>
            ) : error ? (
                <span className="text-red-300">Error: {error}</span>
            ) : txData ? (
                <div className="text-xs">
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Date</span>
                        <span className="text-white">{formatDateTimeLocale(txData.date_time)}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Account</span>
                        <span className="text-white">{txData.account_name || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Type</span>
                        <span className="text-white">{txData.transaction_type || txData.source_transaction_type || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Source</span>
                        <span className="text-white">{txData.source || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Asset</span>
                        <Badge colorScheme="gray">{txData.asset_symbol || '-'}</Badge>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Quantity</span>
                        <span className="font-mono text-white"><ValueDisplay value={txData.quantity} /></span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Unit Price</span>
                        <span className="text-white"><ValueDisplay value={txData.price} /></span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Total</span>
                        <span className="text-white">
                            {txData.total ? <ValueDisplay value={txData.total} currency={baseCurrency} /> : '-'}
                        </span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Quote Asset</span>
                        <span className="text-white">{txData.price_quote_asset_symbol || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Fee</span>
                        <span className="text-white"><ValueDisplay value={txData.fee} /></span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">Fee Quote</span>
                        <span className="text-white">{txData.fee_quote_asset_symbol || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-slate-400">From/To Account</span>
                        <span className="text-white">
                            {txData.direction === 'inflow'
                                ? (txData.from_account_name
                                    ? `${txData.from_account_name}${txData.source_from_account && txData.source_from_account !== txData.from_account_name ? ` (${txData.source_from_account})` : ''}`
                                    : (txData.source_from_account || '-'))
                                : (txData.to_account_name
                                    ? `${txData.to_account_name}${txData.source_to_account && txData.source_to_account !== txData.to_account_name ? ` (${txData.source_to_account})` : ''}`
                                    : (txData.source_to_account || '-'))}
                        </span>
                    </div>
                    {/* View full details link */}
                    {onTransactionClick && (
                        <div className="mt-2 border-t border-slate-600 pt-2 text-center">
                            <span
                                className="cursor-pointer text-blue-300 hover:text-blue-200 hover:underline"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTransactionClick(txId);
                                }}
                            >
                                View full details →
                            </span>
                        </div>
                    )}
                </div>
            ) : (
                <span className="text-slate-400">Hover to load details</span>
            )}
        </div>
    );

    return (
        <Tooltip
            content={tooltipContent}
            openDelay={200}
            closeDelay={100}
        >
            <span className="inline-block" onMouseEnter={fetchTransaction}>
                {children}
            </span>
        </Tooltip>
    );
};

export default TransactionTooltip;
