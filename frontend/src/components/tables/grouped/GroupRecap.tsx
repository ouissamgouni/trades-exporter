import React from 'react';
import type { IconType } from 'react-icons';
import { LuArrowDown, LuArrowUp, LuArrowLeftRight, LuBan, LuCircleCheck, LuClock, LuTriangleAlert } from 'react-icons/lu';
import { cn } from '../../../lib/cn';
import { AccountBadge } from '../../AccountBadge';
import { formatGroupAmount, formatGroupAmountExact, formatNetQty, truncateSymbol } from './groupUtils';
import type { FacetKey, GroupAccountRecap, GroupFacetSelection, TransactionGroup } from './types';

/**
 * Shared column template for month and day header rows so status counts and
 * account recaps line up vertically regardless of label length.
 * Columns: select | label | valid | pending | invalid | health | [P&L] | accounts | actions
 */
export const GROUP_GRID = 'grid grid-cols-[20px_150px_56px_56px_56px_44px_minmax(0,1fr)_auto] items-center gap-x-2';
export const GROUP_GRID_PNL = 'grid grid-cols-[20px_150px_56px_56px_56px_44px_150px_minmax(0,1fr)_auto] items-center gap-x-2';

type StatusKind = 'valid' | 'pending' | 'invalid';

const STATUS_CLASS: Record<StatusKind, string> = {
    valid: 'border-green-200 bg-green-50 text-green-800',
    pending: 'border-amber-200 bg-amber-50 text-amber-800',
    invalid: 'border-slate-200 bg-slate-50 text-slate-400',
};
const STATUS_ICON: Record<StatusKind, IconType> = { valid: LuCircleCheck, pending: LuClock, invalid: LuBan };
const STATUS_LABEL: Record<StatusKind, string> = {
    valid: 'valid',
    pending: 'pending review',
    invalid: 'rejected (excluded from totals)',
};

const StatusCell: React.FC<{ kind: StatusKind; count: number; title?: string }> = ({ kind, count, title }) => {
    const Icon = STATUS_ICON[kind];
    const label = title ?? `${count} ${STATUS_LABEL[kind]}`;
    return (
        <span>
            {count > 0 && (
                <span
                    className={cn('inline-flex items-center gap-1 border px-1.5 py-px text-xs tabular-nums', STATUS_CLASS[kind])}
                    title={label}
                    aria-label={label}
                >
                    <Icon size={11} aria-hidden /> {count}
                </span>
            )}
        </span>
    );
};

/** Grid cells: valid, pending, invalid, health and (P&L tables) realized P&L. Invalid pill only when invalid rows are shown. */
export const GroupStatusCells: React.FC<{
    group: TransactionGroup;
    showPnl: boolean;
    baseCurrency?: string;
    showInvalid?: boolean;
}> = ({ group, showPnl, baseCurrency, showInvalid = true }) => (
    <>
        <StatusCell kind="valid" count={group.valid_count} title={`${group.valid_count} valid · ${group.total_count} total excluding rejected`} />
        <StatusCell kind="pending" count={group.pending_count} />
        {showInvalid ? <StatusCell kind="invalid" count={group.invalid_count} /> : <span />}
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
            <span className="whitespace-nowrap">
                {group.realized_pnl_in_base != null && group.realized_pnl_in_base !== 0 && (
                    <span
                        className={cn('text-xs font-semibold tabular-nums', group.realized_pnl_in_base > 0 ? 'text-green-700' : 'text-red-700')}
                        title={`Realized P&L of the transactions in this period: ${formatGroupAmountExact(group.realized_pnl_in_base)}${baseCurrency ? ` ${baseCurrency}` : ''}`}
                    >
                        Realized {formatGroupAmount(group.realized_pnl_in_base)}{baseCurrency ? ` ${baseCurrency}` : ''}
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

interface FacetToggleProps {
    selection?: GroupFacetSelection;
    onToggleFacet?: (dim: FacetKey, value: string) => void;
}

const accountFacetValue = (recap: GroupAccountRecap) => (recap.account_id != null ? String(recap.account_id) : 'unmapped');

const isSelected = (selection: GroupFacetSelection | undefined, dim: FacetKey, value: string) =>
    (selection?.[dim] ?? []).includes(value);

/** Account pill; acts as a filter toggle when `onToggleFacet` is set (wrapper span: the badge contains its own info button). */
const AccountChip: React.FC<{ recap: GroupAccountRecap } & FacetToggleProps> = ({ recap, selection, onToggleFacet }) => {
    const badge = <AccountBadge accountId={recap.account_id} accountName={recap.account_name} maxLength={18} fallback="Unmapped" />;
    if (!onToggleFacet) return badge;
    const value = accountFacetValue(recap);
    const on = isSelected(selection, 'accounts', value);
    const toggle = () => onToggleFacet('accounts', value);
    return (
        <span
            role="button"
            tabIndex={0}
            aria-pressed={on}
            title={on ? 'Remove account filter' : 'Filter this period by account'}
            className={cn('inline-flex cursor-pointer outline-offset-1', on ? 'outline outline-2 outline-blue-500' : 'hover:outline hover:outline-1 hover:outline-blue-300')}
            onClick={toggle}
            onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            }}
        >
            {badge}
        </span>
    );
};

/** Month recap: one compact card per account, laid out horizontally (scrolls when overflowing). */
export const GroupAccountsStrip: React.FC<{ group: TransactionGroup } & FacetToggleProps> = ({ group, selection, onToggleFacet }) => (
    <div className="flex min-w-0 gap-1.5 overflow-x-auto py-0.5" onClick={e => e.stopPropagation()}>
        {group.accounts.map(recap => (
            <div
                key={recap.account_id ?? 'unmapped'}
                className="flex shrink-0 flex-col gap-0.5 border border-slate-300 bg-slate-100 px-1.5 py-0.5"
            >
                <span className="inline-flex items-center gap-1.5">
                    <AccountChip recap={recap} selection={selection} onToggleFacet={onToggleFacet} />
                    <AccountFlow recap={recap} />
                </span>
                {recap.assets.length > 0 && (
                    <span className="inline-flex items-center gap-x-2 text-[11px] tabular-nums text-slate-500">
                        {recap.assets.map(a => {
                            const value = a.asset_id != null ? String(a.asset_id) : null;
                            const on = value != null && isSelected(selection, 'assets', value);
                            return (
                                <span key={a.asset_id ?? a.symbol} className="whitespace-nowrap">
                                    <span className={a.net_quantity > 0 ? 'text-green-700' : a.net_quantity < 0 ? 'text-red-700' : ''}>
                                        {formatNetQty(a.net_quantity)}
                                    </span>{' '}
                                    {value != null && onToggleFacet ? (
                                        <button
                                            type="button"
                                            aria-pressed={on}
                                            title={on ? `Remove ${a.symbol} filter` : `Filter this period by ${a.symbol}`}
                                            className={cn('px-0.5', on ? 'bg-blue-500 text-white' : 'text-slate-600 hover:text-blue-700 hover:underline')}
                                            onClick={() => onToggleFacet('assets', value)}
                                        >
                                            {truncateSymbol(a.symbol)}
                                        </button>
                                    ) : (
                                        <span className="text-slate-600" title={a.symbol}>{truncateSymbol(a.symbol)}</span>
                                    )}
                                </span>
                            );
                        })}
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
export const GroupAccountsInline: React.FC<{ group: TransactionGroup } & FacetToggleProps> = ({ group, selection, onToggleFacet }) => (
    <div className="flex min-w-0 items-center gap-x-3 overflow-x-auto" onClick={e => e.stopPropagation()}>
        {group.accounts.map(recap => (
            <span key={recap.account_id ?? 'unmapped'} className="inline-flex shrink-0 items-center gap-1">
                <AccountChip recap={recap} selection={selection} onToggleFacet={onToggleFacet} />
                <AccountFlow recap={recap} />
            </span>
        ))}
    </div>
);
