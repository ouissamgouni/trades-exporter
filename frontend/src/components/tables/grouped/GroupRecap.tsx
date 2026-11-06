import React from 'react';
import { LuArrowDown, LuArrowUp, LuArrowLeftRight, LuTriangleAlert } from 'react-icons/lu';
import { Badge } from '../../ui/primitives';
import { cn } from '../../../lib/cn';
import { EntityInfoButton } from '../../EntityInfoButton';
import { formatNetQty, statusChips } from './groupUtils';
import type { GroupAccountRecap, TransactionGroup } from './types';

const STATUS_CLASS: Record<'pending' | 'valid' | 'invalid', string> = {
    pending: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    valid: 'border-green-200 bg-green-50 text-green-800',
    invalid: 'border-slate-200 bg-slate-50 text-slate-400 line-through decoration-slate-300',
};

export const GroupStatusSummary: React.FC<{ group: TransactionGroup; baseCurrency?: string }> = ({ group, baseCurrency }) => (
    <div className="flex flex-wrap items-center gap-1">
        <span
            className="border border-blue-500 bg-blue-500 px-1.5 text-[10px] font-semibold tabular-nums text-white"
            title="Transactions excluding invalid"
        >
            {group.total_count}
        </span>
        {statusChips(group).map(chip => (
            <span
                key={chip.key}
                className={cn('border px-1 text-[10px] tabular-nums', STATUS_CLASS[chip.key])}
                title={chip.key === 'invalid' ? 'Invalid transactions are excluded from totals' : undefined}
            >
                {chip.count} {chip.label}
            </span>
        ))}
        {group.health_issue_count > 0 && (
            <Badge colorScheme="orange" className="text-[10px]" title="Transactions with data health issues (unlinked/missing data)">
                <LuTriangleAlert size={10} /> {group.health_issue_count}
            </Badge>
        )}
        {group.realized_pnl_in_base != null && group.realized_pnl_in_base !== 0 && (
            <span
                className={cn('px-1 text-[10px] font-semibold tabular-nums', group.realized_pnl_in_base > 0 ? 'text-green-700' : 'text-red-700')}
                title="Realized P&L in this period"
            >
                P&L {formatNetQty(group.realized_pnl_in_base)}{baseCurrency ? ` ${baseCurrency}` : ''}
            </span>
        )}
    </div>
);

const AccountFlow: React.FC<{ recap: GroupAccountRecap }> = ({ recap }) => (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
        {recap.inflow_count > 0 && (
            <span className="inline-flex items-center text-green-700" title={`${recap.inflow_count} inflow`}>
                <LuArrowDown size={10} />{recap.inflow_count}
            </span>
        )}
        {recap.outflow_count > 0 && (
            <span className="inline-flex items-center text-red-700" title={`${recap.outflow_count} outflow`}>
                <LuArrowUp size={10} />{recap.outflow_count}
            </span>
        )}
        {recap.internal_transfer_count > 0 && (
            <span className="inline-flex items-center gap-0.5 text-slate-500" title={`${recap.internal_transfer_count} internal transfer(s) between owned accounts`}>
                <LuArrowLeftRight size={10} />{recap.internal_transfer_count}
            </span>
        )}
    </span>
);

const AccountName: React.FC<{ recap: GroupAccountRecap }> = ({ recap }) => (
    <span className="inline-flex min-w-0 items-center gap-0.5">
        <span className="max-w-[160px] truncate font-medium text-slate-700" title={recap.account_name ?? 'Unmapped'}>
            {recap.account_name ?? 'Unmapped'}
        </span>
        <EntityInfoButton kind="account" id={recap.account_id} label={recap.account_name} size={10} />
    </span>
);

/** Per-account recap: one line per account with flows and top net asset quantities. */
export const GroupAccountsRecap: React.FC<{ group: TransactionGroup; maxAccounts?: number }> = ({ group, maxAccounts = 6 }) => {
    const shown = group.accounts.slice(0, maxAccounts);
    const hidden = group.accounts.length - shown.length;
    return (
        <div className="flex flex-col gap-0.5 text-[10px]">
            {shown.map(recap => (
                <div key={recap.account_id ?? 'unmapped'} className="flex flex-wrap items-center gap-x-2">
                    <AccountName recap={recap} />
                    <AccountFlow recap={recap} />
                    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-slate-500">
                        {recap.assets.map(a => (
                            <span key={a.asset_id ?? a.symbol} className="tabular-nums">
                                <span className={a.net_quantity > 0 ? 'text-green-700' : a.net_quantity < 0 ? 'text-red-700' : ''}>
                                    {formatNetQty(a.net_quantity)}
                                </span>{' '}
                                <span className="text-slate-600">{a.symbol}</span>
                            </span>
                        ))}
                        {recap.more_assets_count > 0 && (
                            <span className="text-slate-400" title={`${recap.more_assets_count} more asset(s)`}>+{recap.more_assets_count}</span>
                        )}
                    </span>
                </div>
            ))}
            {hidden > 0 && <span className="text-slate-400">+{hidden} more account(s)</span>}
        </div>
    );
};

/** Single-line account recap for day headers. */
export const GroupAccountsInline: React.FC<{ group: TransactionGroup; maxAccounts?: number }> = ({ group, maxAccounts = 3 }) => {
    const shown = group.accounts.slice(0, maxAccounts);
    const hidden = group.accounts.length - shown.length;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-[10px]">
            {shown.map(recap => (
                <span key={recap.account_id ?? 'unmapped'} className="inline-flex items-center gap-1">
                    <AccountName recap={recap} />
                    <AccountFlow recap={recap} />
                </span>
            ))}
            {hidden > 0 && <span className="text-slate-400">+{hidden}</span>}
        </div>
    );
};
