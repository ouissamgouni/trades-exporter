import React, { useMemo } from 'react';
import type { Transaction } from '../../../types';
import { formatDayLabel, formatMonthLabel, parseApiDate, toLocalDateKey } from '../../../utils/dateUtils';

interface PageDayGroupedRowsProps {
    transactions: Transaction[];
    colSpan: number;
    renderRow: (tx: Transaction) => React.ReactNode;
}

/** Light day headers built from the current page only (used where no grouping endpoint exists). */
export const PageDayGroupedRows: React.FC<PageDayGroupedRowsProps> = ({ transactions, colSpan, renderRow }) => {
    const days = useMemo(() => {
        const map = new Map<string, Transaction[]>();
        for (const tx of transactions) {
            const d = parseApiDate(tx.date_time);
            const key = d ? toLocalDateKey(d) : 'unknown';
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(tx);
        }
        return [...map.entries()];
    }, [transactions]);

    const currentYear = new Date().getFullYear();
    return (
        <>
            {days.map(([key, txs]) => {
                const valid = txs.filter(t => t.review_status !== 'invalid');
                const inflow = valid.filter(t => t.direction === 'inflow').length;
                const outflow = valid.filter(t => t.direction === 'outflow').length;
                const sameYear = key.startsWith(String(currentYear));
                const label = key === 'unknown'
                    ? 'No date'
                    : `${formatDayLabel(key)}${sameYear ? ` ${formatMonthLabel(key).slice(0, 3)}` : ` ${formatMonthLabel(key)}`}`;
                return (
                    <React.Fragment key={key}>
                        <tr className="bg-slate-50">
                            <td colSpan={colSpan} className="border-b border-l-4 border-slate-200 border-l-slate-300 px-2 py-1 text-xs">
                                <span className="font-semibold text-slate-700">{label}</span>
                                <span className="ml-2 tabular-nums text-slate-500">
                                    {valid.length} · <span className="text-green-700">↓{inflow}</span> <span className="text-red-700">↑{outflow}</span>
                                    <span className="ml-1 text-slate-400">(this page)</span>
                                </span>
                            </td>
                        </tr>
                        {txs.map(tx => <React.Fragment key={tx.id}>{renderRow(tx)}</React.Fragment>)}
                    </React.Fragment>
                );
            })}
        </>
    );
};
