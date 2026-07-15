import React from 'react';
import { Badge } from './ui/primitives';

interface CounterpartyFilterCardProps {
    nonOwned: boolean;
    onToggle: (value: boolean) => void;
    nonOwnedCount?: number;
}

/**
 * A filter card for the P&L context that toggles the "Non-Owned" filter.
 *
 * "Non-Owned" includes transactions where any counterparty (from/to account)
 * is either explicitly marked as non-owned or is unmapped (NULL).
 *
 * Designed to be passed as `extraFilterCards` to TransactionFilters.
 */
export const CounterpartyFilterCard: React.FC<CounterpartyFilterCardProps> = ({
    nonOwned,
    onToggle,
    nonOwnedCount,
}) => {
    return (
        <div className={`min-h-[70px] border bg-white p-2 ${nonOwned ? 'border-red-200' : 'border-slate-200'}`}>
            {/* Header */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold text-slate-600">🔗 Counterparty</span>
                </div>
                {nonOwned && (
                    <Badge colorScheme="red">1 active</Badge>
                )}
            </div>

            {/* Toggle chip */}
            <div className="flex flex-wrap gap-1.5">
                <button
                    type="button"
                    onClick={() => onToggle(!nonOwned)}
                    className={`inline-flex select-none items-center gap-1 border px-2 py-0.5 text-sm font-medium leading-tight transition-opacity hover:opacity-80 ${nonOwned ? 'border-red-500 bg-red-500 text-white' : 'border-slate-200 bg-white text-slate-600'}`}
                >
                    🚫 Non-Owned
                    {nonOwnedCount !== undefined && nonOwnedCount > 0 && (
                        <span className="ml-1 text-[10px] opacity-80">({nonOwnedCount})</span>
                    )}
                </button>
            </div>

            {/* Helper text */}
            <span className="mt-1.5 block text-[10px] text-slate-400">
                Includes unmapped accounts
            </span>
        </div>
    );
};

export default CounterpartyFilterCard;
