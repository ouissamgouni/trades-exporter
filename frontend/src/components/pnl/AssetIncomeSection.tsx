/**
 * AssetIncomeSection — Income events for a single asset within the Asset Detail panel.
 *
 * Shows a table of dividend/interest income events for a specific asset,
 * with gross, withholding, and net amounts.
 */

import React from 'react';
import { LuBanknote } from 'react-icons/lu';
import { useIncomeEvents, type IncomeEventItem } from '../../hooks/useChartData';
import { ValueDisplay } from '../ValueDisplay';
import { Badge } from '../ui/primitives';

interface AssetIncomeSectionProps {
    assetId: number;
    versionId: number;
    baseCurrency?: string;
}

const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const AssetIncomeSection: React.FC<AssetIncomeSectionProps> = ({
    assetId, versionId, baseCurrency = 'EUR',
}) => {
    const { data, isLoading } = useIncomeEvents(versionId, { assetId, limit: 200 });

    if (isLoading) {
        return <span className="p-2 text-xs text-slate-400">Loading income events...</span>;
    }

    const events = data?.items ?? [];
    if (events.length === 0) {
        return null; // Don't render section if no income events
    }

    // Totals
    let totalGross = 0, totalWht = 0, totalNet = 0;
    for (const e of events) {
        totalGross += e.gross_amount_in_base;
        totalWht += e.withholding_amount_in_base;
        totalNet += e.net_amount_in_base;
    }

    return (
        <div>
            {/* Summary */}
            <div className="mb-2 flex flex-wrap gap-4 bg-teal-50 p-2">
                <div>
                    <span className="block text-[10px] text-slate-500">Gross</span>
                    <span className="block text-xs font-bold text-teal-700">
                        <ValueDisplay value={totalGross} currency={baseCurrency} />
                    </span>
                </div>
                <div>
                    <span className="block text-[10px] text-slate-500">Withholding</span>
                    <span className="block text-xs font-bold text-red-500">
                        <ValueDisplay value={-totalWht} currency={baseCurrency} />
                    </span>
                </div>
                <div>
                    <span className="block text-[10px] text-slate-500">Net</span>
                    <span className="block text-xs font-bold text-teal-700">
                        <ValueDisplay value={totalNet} currency={baseCurrency} />
                    </span>
                </div>
                <div>
                    <span className="block text-[10px] text-slate-500">Events</span>
                    <span className="block text-xs font-bold text-slate-600">{events.length}</span>
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="bg-slate-50">
                            <th className="px-2 py-1 text-left">Date</th>
                            <th className="px-2 py-1 text-left">Type</th>
                            <th className="px-2 py-1 text-left">Account</th>
                            <th className="px-2 py-1 text-right">Gross</th>
                            <th className="px-2 py-1 text-right">WHT</th>
                            <th className="px-2 py-1 text-right">Net</th>
                            <th className="px-2 py-1 text-left">Country</th>
                        </tr>
                    </thead>
                    <tbody>
                        {events.map(e => (
                            <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                                <td className="whitespace-nowrap px-2 py-1">{fmtDate(e.income_at)}</td>
                                <td className="px-2 py-1">
                                    <Badge colorScheme="green">{e.income_type}</Badge>
                                </td>
                                <td className="px-2 py-1 text-slate-600">{e.account_name || '—'}</td>
                                <td className="px-2 py-1 text-right text-teal-700">
                                    <ValueDisplay value={e.gross_amount_in_base} currency={baseCurrency} />
                                </td>
                                <td className="px-2 py-1 text-right text-red-500">
                                    {e.withholding_amount_in_base > 0 ? (
                                        <>-<ValueDisplay value={e.withholding_amount_in_base} currency={baseCurrency} /></>
                                    ) : '—'}
                                </td>
                                <td className="px-2 py-1 text-right font-semibold text-teal-600">
                                    <ValueDisplay value={e.net_amount_in_base} currency={baseCurrency} />
                                </td>
                                <td className="px-2 py-1 text-[10px] text-slate-500">
                                    {e.withholding_jurisdiction || '—'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
