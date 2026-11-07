import React from 'react';
import { LuArrowDown, LuArrowUp, LuArrowLeftRight, LuTriangleAlert } from 'react-icons/lu';
import { cn } from '../../../lib/cn';
import { AccountBadge } from '../../AccountBadge';
import { formatNetQty, truncateSymbol } from './groupUtils';
import type { GroupAccountRecap, TransactionGroup } from './types';

/**
 * Shared column template for month and day header rows so totals, status counts and
 * account recaps line up vertically regardless of label length.
 * Columns: select | label | total | pending | valid | invalid | health | [P&L] | accounts | actions
 */
export const GROUP_GRID = 'grid grid-cols-[20px_150px_52px_96px_88px_88px_52px_minmax(0,1fr)_auto] items-center gap-x-2';
export const GROUP_GRID_PNL = 'grid grid-cols-[20px_150px_52px_96px_88px_88px_52px_120px_minmax(0,1fr)_auto] items-center gap-x-2';
/** Grid column where the recap cells start (after select + label). */
export const GROUP_RECAP_COL_START = 'col-[3/-1]';

const STATUS_CLASS: Record<'pending' | 'valid' | 'invalid', string> = {
    pending: 'border-amber-200 bg-amber-50 text-amber-800',
    valid: 'border-green-200 bg-green-50 text-green-800',
    invalid: 'border-slate-200 bg-slate-50 text-slate-400 line-through decoration-slate-300',
};
const INVALID_TOGGLE = 'inline-flex items-center gap-1 border border-slate-300 bg-white px-1.5 py-px text-xs tabular-nums text-slate-500 hover:border-slate-400 hover:text-slate-800';

const StatusCell: React.FC<{ kind: 'pending' | 'valid' | 'invalid'; count: number }> = ({ kind, count }) => (
    <span>
        {count > 0 && (
            <span
                className={cn('inline-block border px-1.5 py-px text-xs tabular-nums', STATUS_CLASS[kind])}
                title={kind === 'invalid' ? 'Invalid transactions are excluded from totals' : undefined}
            >
                {count} {kind}
            </span>
        )}
    </span>
);

/** Grid cells: total, pending, valid, invalid, health and (P&L tables) realized P&L. */
export const GroupStatusCells: React.FC<{
    group: TransactionGroup;
    showPnl: boolean;
    baseCurrency?: string;
    /** When set, the invalid pill becomes a +/- toggle for the invalid rows. */
    onToggleInvalid?: () => void;
    invalidShown?: boolean;
}> = ({ group, showPnl, baseCurrency, onToggleInvalid, invalidShown }) => (
    <>
        <span>
            <span
                className="inline-block min-w-[28px] border border-slate-300 bg-white px-1.5 py-px text-center text-xs font-semibold tabular-nums text-slate-700"
                title="Transactions excluding invalid"
            >
                {group.total_count}
            </span>
        </span>
        <StatusCell kind="pending" count={group.pending_count} />
        <StatusCell kind="valid" count={group.valid_count} />
        {onToggleInvalid && group.invalid_count > 0 ? (
            <span>
                <button
                    type="button"
                    aria-pressed={!!invalidShown}
                    className={INVALID_TOGGLE}
                    title={invalidShown ? 'Hide invalid transactions' : 'Show invalid transactions'}
                    onClick={e => { e.stopPropagation(); onToggleInvalid(); }}
                >
                    <span className="font-semibold">{invalidShown ? '−' : '+'}</span>
                    <span className="line-through decoration-slate-300">{group.invalid_count} invalid</span>
                </button>
            </span>
        ) : (
            <StatusCell kind="invalid" count={group.invalid_count} />
        )}
        <span>
            {group.health_issue_count > 0 && (
                <span
                    className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums text-orange-700"
                    title="Transactions with data health issues (unlinked/missing data)"
                >
                    <LuTriangleAlert size={12} /> {group.health_issue_count}
                </span>
            )}
        </span>
        {showPnl && (
            <span className="truncate">
                {group.realized_pnl_in_base != null && group.realized_pnl_in_base !== 0 && (
                    <span
                        className={cn('text-xs font-semibold tabular-nums', group.realized_pnl_in_base > 0 ? 'text-green-700' : 'text-red-700')}
                        title="Realized P&L in this period"
                    >
                        P&L {formatNetQty(group.realized_pnl_in_base)}{baseCurrency ? ` ${baseCurrency}` : ''}
                    </span>
                )}
            </span>
        )}
    </>
);

const AccountFlow: React.FC<{ recap: GroupAccountRecap }> = ({ recap }) => (
    <span className="inline-flex items-center gap-1.5 text-xs tabular-nums">
        {recap.inflow_count > 0 && (
            <span className="inline-flex items-center text-green-700" title={`${recap.inflow_count} inflow`}>
                <LuArrowDown size={11} />{recap.inflow_count}
            </span>
        )}
        {recap.outflow_count > 0 && (
            <span className="inline-flex items-center text-red-700" title={`${recap.outflow_count} outflow`}>
                <LuArrowUp size={11} />{recap.outflow_count}
            </span>
        )}
        {recap.internal_transfer_count > 0 && (
            <span className="inline-flex items-center gap-0.5 text-slate-500" title={`${recap.internal_transfer_count} internal transfer(s) between owned accounts`}>
                <LuArrowLeftRight size={11} />{recap.internal_transfer_count}
            </span>
        )}
    </span>
);

const AccountPill: React.FC<{ recap: GroupAccountRecap }> = ({ recap }) => (
    <AccountBadge accountId={recap.account_id} accountName={recap.account_name} maxLength={18} fallback="Unmapped" />
);

/** Month recap: one compact card per account, laid out horizontally (scrolls when overflowing). */
export const GroupAccountsStrip: React.FC<{ group: TransactionGroup }> = ({ group }) => (
    <div className="flex min-w-0 gap-1.5 overflow-x-auto py-0.5" onClick={e => e.stopPropagation()}>
        {group.accounts.map(recap => (
            <div
                key={recap.account_id ?? 'unmapped'}
                className="flex shrink-0 flex-col gap-0.5 border border-slate-200 bg-white px-1.5 py-0.5"
            >
                <span className="inline-flex items-center gap-1.5">
                    <AccountPill recap={recap} />
                    <AccountFlow recap={recap} />
                </span>
                {recap.assets.length > 0 && (
                    <span className="inline-flex items-center gap-x-2 text-[11px] tabular-nums text-slate-500">
                        {recap.assets.map(a => (
                            <span key={a.asset_id ?? a.symbol} className="whitespace-nowrap">
                                <span className={a.net_quantity > 0 ? 'text-green-700' : a.net_quantity < 0 ? 'text-red-700' : ''}>
                                    {formatNetQty(a.net_quantity)}
                                </span>{' '}
                                <span className="text-slate-600" title={a.symbol}>{truncateSymbol(a.symbol)}</span>
                            </span>
                        ))}
                        {recap.more_assets_count > 0 && (
                            <span className="text-slate-400" title={`${recap.more_assets_count} more asset(s)`}>+{recap.more_assets_count}</span>
                        )}
                    </span>
                )}
            </div>
        ))}
    </div>
);

/** Day recap: account pills with flow counts on a single line. */
export const GroupAccountsInline: React.FC<{ group: TransactionGroup }> = ({ group }) => (
    <div className="flex min-w-0 items-center gap-x-3 overflow-x-auto" onClick={e => e.stopPropagation()}>
        {group.accounts.map(recap => (
            <span key={recap.account_id ?? 'unmapped'} className="inline-flex shrink-0 items-center gap-1">
                <AccountPill recap={recap} />
                <AccountFlow recap={recap} />
            </span>
        ))}
    </div>
);
