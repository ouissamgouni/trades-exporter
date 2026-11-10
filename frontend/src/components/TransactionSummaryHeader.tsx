/**
 * TransactionSummaryHeader — sticky summary at the top of the transaction side panel:
 * signed amount + asset, value, status chips, date/account and the main review actions.
 */

import React from 'react';
import { FiArrowDown, FiArrowUp, FiArrowRight, FiEdit2 } from 'react-icons/fi';
import { Transaction, Account } from '../types';
import { ReviewStatus, getReviewStatusLabel } from '../enums';
import { getSpamLevel } from '../hooks/useSpamReview';
import { formatDateTimeLocale } from '../utils/dateUtils';
import { AssetBadge } from './AssetBadge';
import { AccountBadge } from './AccountBadge';
import { ValueDisplay } from './ValueDisplay';
import { Badge, Button, type BadgeColorScheme } from './ui/primitives';

interface TransactionSummaryHeaderProps {
    tx: Transaction;
    accounts: Account[];
    onReview: (status: string) => void;
    onEdit: () => void;
    onOpenBundle: () => void;
    onOpenPricing: () => void;
    reviewing?: boolean;
}

const REVIEW_COLORS: Record<string, BadgeColorScheme> = {
    valid: 'green',
    invalid: 'red',
    pending: 'yellow',
};

export const TransactionSummaryHeader: React.FC<TransactionSummaryHeaderProps> = ({
    tx, accounts, onReview, onEdit, onOpenBundle, onOpenPricing, reviewing = false,
}) => {
    const isIn = tx.direction === 'inflow';
    const isOut = tx.direction === 'outflow';
    const sign = isIn ? '+' : isOut ? '−' : '';
    const amountColor = isIn ? 'text-green-700' : isOut ? 'text-red-700' : 'text-slate-700';
    const spamLevel = getSpamLevel(tx);
    const missingPrice = tx.price == null && tx.transaction_type !== 'memo';
    const account = accounts.find(a => a.id === tx.account_id);

    return (
        <div className="border-b border-slate-200 bg-white px-3 pb-2 pt-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className={`flex items-center gap-2 text-2xl font-semibold tabular-nums ${amountColor}`}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100">
                            {isIn ? <FiArrowDown size={16} /> : isOut ? <FiArrowUp size={16} /> : <FiArrowRight size={16} />}
                        </span>
                        <span className="truncate">{sign}<ValueDisplay value={tx.quantity} /></span>
                        <AssetBadge asset={tx.linked_asset} sourceSymbol={tx.source_asset_symbol} size="md" maxLength={14} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-slate-600">
                        {tx.total != null ? (
                            <>
                                <span>=</span>
                                <span className="font-mono"><ValueDisplay value={tx.total} /></span>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    showWarning={false}
                                />
                                <Badge colorScheme="gray" className="text-[10px]" title="Price imported with the transaction">
                                    source price
                                </Badge>
                            </>
                        ) : (
                            <button type="button" onClick={onOpenPricing} className="text-orange-600 hover:underline">
                                No price, set it in Pricing
                            </button>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                    {tx.review_status !== ReviewStatus.VALID && (
                        <Button size="sm" colorScheme="green" disabled={reviewing} onClick={() => onReview(ReviewStatus.VALID)}>
                            ✓ Mark as valid
                        </Button>
                    )}
                    <div className="flex gap-1">
                        {tx.review_status !== ReviewStatus.INVALID && (
                            <Button size="sm" variant="outline" colorScheme="red" disabled={reviewing} onClick={() => onReview(ReviewStatus.INVALID)}>
                                ✗ Reject
                            </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={onEdit} title="Edit fields in the Details tab">
                            <FiEdit2 size={12} /> Edit
                        </Button>
                    </div>
                </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge colorScheme={REVIEW_COLORS[tx.review_status] ?? 'gray'}>
                    {getReviewStatusLabel(tx.review_status || '')}
                </Badge>
                <Badge colorScheme="blue">{tx.transaction_type || '-'}</Badge>
                {spamLevel && (
                    <Badge colorScheme={spamLevel === 'confirmed' ? 'red' : 'orange'}>
                        {spamLevel === 'confirmed' ? 'Spam' : 'Suspected spam'}
                    </Badge>
                )}
                {tx.user_calculation_unit_id != null && (
                    <Badge colorScheme="purple" className="cursor-pointer hover:opacity-80" onClick={onOpenBundle}>
                        📦 #{tx.user_calculation_unit_id}
                    </Badge>
                )}
                {missingPrice && (
                    <Badge colorScheme="orange" className="cursor-pointer hover:opacity-80" onClick={onOpenPricing}>
                        Price missing
                    </Badge>
                )}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-slate-500">
                <span>{formatDateTimeLocale(tx.date_time)}</span>
                <span>·</span>
                <AccountBadge account={account} accountId={tx.account_id ?? undefined} accountName={tx.account_name} size="xs" maxLength={22} />
                {tx.connector_name && <Badge colorScheme="gray" className="text-[10px]">{tx.connector_name}</Badge>}
            </div>
        </div>
    );
};

export default TransactionSummaryHeader;
