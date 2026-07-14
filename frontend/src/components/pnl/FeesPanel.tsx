/**
 * Fees Panel
 * 
 * Shows all fees with traceability to source transactions.
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React, { useState } from 'react';
import { FiExternalLink, FiSearch, FiDownload } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { FeeEntry, FeeSummary } from './types';
import { formatDateLocale } from '../../utils/dateUtils';
import { Badge, Button, Input } from '../ui/primitives';

interface FeesPanelProps {
    fees: FeeEntry[];
    summary: FeeSummary;
    baseCurrency: string;
    onClose: () => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

const formatQty = (value: number): string => {
    return value.toFixed(8).replace(/\.?0+$/, '');
};

// Using formatDateLocale from utils/dateUtils for date formatting

export const FeesPanel: React.FC<FeesPanelProps> = ({
    fees,
    summary,
    baseCurrency,
    onClose,
    onTransactionClick,
    onUnitClick,
}) => {
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string>('');

    const uniqueSources = [...new Set(fees.map(f => f.source))];

    const filtered = fees.filter((fee) => {
        if (search && !fee.asset_symbol.toLowerCase().includes(search.toLowerCase())) {
            return false;
        }
        if (sourceFilter && fee.source !== sourceFilter) {
            return false;
        }
        return true;
    });

    return (
        <SlidePanel
            isOpen={true}
            onClose={onClose}
            title="💰 Fees Breakdown"
            width="700px"
        >
            {/* Summary Cards */}
            <div className="mb-4 flex flex-wrap gap-4">
                <div className="min-w-[150px] flex-1 border border-slate-200 bg-white">
                    <div className="px-4 py-3">
                        <span className="block text-xs text-slate-500">Total Fees</span>
                        <span className="block text-xl font-bold">
                            {formatCurrency(summary.total_fees_in_base, baseCurrency)}
                        </span>
                    </div>
                </div>
                <div className="min-w-[150px] flex-1 border border-slate-200 bg-white">
                    <div className="px-4 py-3">
                        <span className="block text-xs text-slate-500">Taxable Fee Events</span>
                        <span className="block text-xl font-bold text-orange-600">
                            {summary.disposal_taxable_fee_count}
                        </span>
                    </div>
                </div>
                <div className="min-w-[150px] flex-1 border border-slate-200 bg-white">
                    <div className="px-4 py-3">
                        <span className="block text-xs text-slate-500">Fee Entries</span>
                        <span className="block text-xl font-bold">
                            {fees.length}
                        </span>
                    </div>
                </div>
            </div>

            {/* Fees by Asset */}
            <div className="mb-4 border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                    <span className="text-sm font-bold">Fees by Asset</span>
                </div>
                <div className="px-4 py-2">
                    <div className="flex flex-wrap gap-2">
                        {Object.entries(summary.fees_by_asset)
                            .sort(([, a], [, b]) => b - a)
                            .slice(0, 10)
                            .map(([asset, amount]) => (
                                <Badge key={asset} colorScheme="purple" className="px-2 py-1">
                                    {asset}: {formatCurrency(amount, baseCurrency)}
                                </Badge>
                            ))}
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="mb-4 flex items-center gap-2">
                <div className="relative flex-1">
                    <Input
                        placeholder="Search by asset..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-8"
                    />
                    <div className="absolute left-2 top-1/2 -translate-y-1/2">
                        <FiSearch size={14} color="gray" />
                    </div>
                </div>
                <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value)}
                    style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid #e2e8f0',
                        fontSize: '14px',
                    }}
                >
                    <option value="">All Sources</option>
                    {uniqueSources.map((src) => (
                        <option key={src} value={src}>{src}</option>
                    ))}
                </select>
                <Button size="sm" variant="outline">
                    <FiDownload /> Export
                </Button>
            </div>

            {/* Fees Table */}
            <div className="border border-slate-200 bg-white">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-50 text-left">
                                <th className="px-2 py-1">Date</th>
                                <th className="px-2 py-1">Source</th>
                                <th className="px-2 py-1">Asset</th>
                                <th className="px-2 py-1">Fee Amount</th>
                                <th className="px-2 py-1">In Base</th>
                                <th className="px-2 py-1">Realized P&L</th>
                                <th className="px-2 py-1">Origin</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={7}>
                                        <span className="block py-4 text-center text-slate-500">
                                            No fees match your criteria
                                        </span>
                                    </td>
                                </tr>
                            ) : (
                                filtered.map((fee) => (
                                    <tr key={fee.id} className="border-b border-slate-100 hover:bg-slate-50">
                                        <td className="px-2 py-1">
                                            <span className="text-sm">{formatDateLocale(fee.date)}</span>
                                        </td>
                                        <td className="px-2 py-1">
                                            <Badge>
                                                {fee.source}
                                            </Badge>
                                        </td>
                                        <td className="px-2 py-1">
                                            <Badge>{fee.asset_symbol}</Badge>
                                        </td>
                                        <td className="px-2 py-1">
                                            <span className="font-mono text-sm">
                                                {formatQty(fee.fee_amount)}
                                            </span>
                                        </td>
                                        <td className="px-2 py-1">
                                            {formatCurrency(fee.fee_in_base, baseCurrency)}
                                        </td>
                                        <td className="px-2 py-1">
                                            {fee.realized_pnl !== undefined ? (
                                                <span
                                                    className={`text-sm ${fee.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                                >
                                                    {formatCurrency(fee.realized_pnl, baseCurrency)}
                                                </span>
                                            ) : (
                                                <span className="text-sm text-slate-400">—</span>
                                            )}
                                        </td>
                                        <td className="px-2 py-1">
                                            <div className="flex gap-1">
                                                {fee.transaction_id && onTransactionClick && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => onTransactionClick(fee.transaction_id!)}
                                                    >
                                                        TX
                                                        <FiExternalLink size={12} />
                                                    </Button>
                                                )}
                                                {fee.unit_id && onUnitClick && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => onUnitClick(fee.unit_id!)}
                                                    >
                                                        Unit
                                                        <FiExternalLink size={12} />
                                                    </Button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </SlidePanel>
    );
};

export default FeesPanel;
