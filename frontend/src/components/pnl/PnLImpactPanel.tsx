/**
 * P&L Impact Panel
 * 
 * Shows detailed breakdown of a single economic event:
 * - Event type, date, taxable status
 * - Which lots were consumed
 * - Related transactions/bundle
 * - Why taxable or not
 * 
 * Principle 3: Everything must be traceable
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React from 'react';
import { Badge, Button } from '../ui/primitives';
import { FiExternalLink, FiInfo, FiArrowRight } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { PnLImpactEvent, ConsumedLotDetail, EventTransaction } from './types';
import { formatDateLocale, formatDateTimeLocale } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
import { ValueDisplay } from '../ValueDisplay';

interface PnLImpactPanelProps {
    event: PnLImpactEvent;
    baseCurrency: string;
    onClose: () => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}

// Using formatDateLocale and formatDateTimeLocale from utils/dateUtils

export const PnLImpactPanel: React.FC<PnLImpactPanelProps> = ({
    event,
    baseCurrency,
    onClose,
    onTransactionClick,
    onUnitClick,
}) => {
    return (
        <SlidePanel
            isOpen={true}
            onClose={onClose}
            title="P&L Impact Details"
            width="600px"
        >
            {/* Event Summary */}
            <div className="mb-4 border border-slate-200 bg-white p-4">
                <div className="mb-4 flex items-start justify-between">
                    <div>
                        <div className="mb-1 flex items-center gap-2">
                            <Badge
                                colorScheme={
                                    event.event_type === 'disposal' ? 'red' :
                                        event.event_type === 'fee' ? 'purple' :
                                            event.event_type === 'swap' ? 'orange' : 'gray'
                                }
                                className="px-2.5 py-1 text-sm"
                            >
                                {event.event_type.toUpperCase()}
                            </Badge>
                            {event.disposal_taxable ? (
                                <Badge colorScheme="red">Taxable Event</Badge>
                            ) : (
                                <Badge colorScheme="green">Non-Taxable</Badge>
                            )}
                        </div>
                        <span className="block text-sm text-slate-600">
                            {formatDateTimeLocale(event.event_date)}
                        </span>
                    </div>
                    <div className="text-right">
                        <span className="block text-sm text-slate-500">Total P&L</span>
                        <span className={`block text-2xl font-bold ${event.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            <ValueDisplay value={event.total_pnl} currency={baseCurrency} />
                        </span>
                    </div>
                </div>

                {/* P&L Breakdown */}
                <div className="bg-slate-50 p-3">
                    <div className="mb-2 flex justify-between">
                        <span className="text-sm">Proceeds</span>
                        <span className="text-sm font-medium">
                            <ValueDisplay value={event.total_proceeds} currency={baseCurrency} />
                        </span>
                    </div>
                    <div className="mb-2 flex justify-between">
                        <span className="text-sm">Cost Basis</span>
                        <span className="text-sm font-medium">
                            - <ValueDisplay value={event.total_cost_basis} currency={baseCurrency} />
                        </span>
                    </div>
                    {event.total_fees > 0 && (
                        <div className="mb-2 flex justify-between">
                            <span className="text-sm">Fees</span>
                            <span className="text-sm font-medium">
                                - <ValueDisplay value={event.total_fees} currency={baseCurrency} />
                            </span>
                        </div>
                    )}
                    <div className="mt-2 border-t border-slate-300 pt-2">
                        <div className="flex justify-between">
                            <span className="font-bold">Net P&L</span>
                            <span className={`font-bold ${event.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                <ValueDisplay value={event.total_pnl} currency={baseCurrency} />
                            </span>
                        </div>
                    </div>
                </div>

                {/* Unit info */}
                {event.unit_id && (
                    <div className="mt-4 flex items-center gap-2">
                        <FiInfo color="gray" />
                        <span className="text-sm text-slate-600">
                            Calculation Unit:
                        </span>
                        <Button
                            size="sm"
                            variant="ghost"
                            colorScheme="blue"
                            onClick={() => onUnitClick?.(event.unit_id!)}
                        >
                            {event.unit_label || `#${event.unit_id}`}
                            <FiExternalLink size={12} />
                        </Button>
                        {event.unit_pattern && (
                            <Badge>{event.unit_pattern}</Badge>
                        )}
                    </div>
                )}
            </div>

            {/* Consumed Lots */}
            <div className="mb-4 border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                    <span className="text-sm font-bold">Lots Consumed ({event.consumed_lots.length})</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-50 text-left">
                                <th className="px-2 py-1">Acquired</th>
                                <th className="px-2 py-1">Qty</th>
                                <th className="px-2 py-1">Unit Cost</th>
                                <th className="px-2 py-1">Cost Basis</th>
                                <th className="px-2 py-1">Holding</th>
                            </tr>
                        </thead>
                        <tbody>
                            {event.consumed_lots.map((lot, idx) => (
                                <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                                    <td className="px-2 py-1">
                                        <div className="flex flex-col">
                                            <span className="text-sm">{formatDateLocale(lot.acquired_at)}</span>
                                            {lot.origin_transaction_id && onTransactionClick && (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => onTransactionClick(lot.origin_transaction_id!)}
                                                >
                                                    TX #{lot.origin_transaction_id}
                                                </Button>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-2 py-1">
                                        <span className="font-mono text-sm">
                                            <ValueDisplay value={lot.qty_consumed} />
                                        </span>
                                    </td>
                                    <td className="px-2 py-1">
                                        <ValueDisplay value={lot.unit_cost} />
                                    </td>
                                    <td className="px-2 py-1">
                                        <ValueDisplay value={lot.cost_basis} currency={baseCurrency} />
                                    </td>
                                    <td className="px-2 py-1">
                                        <div className="flex items-center gap-1">
                                            <span className="text-sm">{lot.holding_days}d</span>
                                            {lot.holding_days >= 365 && (
                                                <Badge colorScheme="green">LT</Badge>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Related Transactions */}
            <div className="border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                    <span className="text-sm font-bold">Related Transactions ({event.transactions.length})</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-50 text-left">
                                <th className="px-2 py-1">Date</th>
                                <th className="px-2 py-1">Source</th>
                                <th className="px-2 py-1">Type</th>
                                <th className="px-2 py-1">Asset</th>
                                <th className="px-2 py-1">Qty</th>
                                <th className="px-2 py-1">Total</th>
                                <th className="px-2 py-1"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {event.transactions.map((tx) => (
                                <tr key={tx.transaction_id} className="border-b border-slate-100 hover:bg-slate-50">
                                    <td className="px-2 py-1">
                                        <span className="text-sm">{formatDateTimeLocale(tx.date_time)}</span>
                                    </td>
                                    <td className="px-2 py-1">
                                        <Badge>{tx.source}</Badge>
                                    </td>
                                    <td className="px-2 py-1">
                                        <div className="flex items-center gap-1">
                                            <Badge colorScheme={tx.direction === 'inflow' ? 'green' : 'red'}>
                                                {tx.direction}
                                            </Badge>
                                            <span className="text-xs text-slate-500">
                                                {tx.transaction_type}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-2 py-1">
                                        <Badge>{tx.asset_symbol}</Badge>
                                    </td>
                                    <td className="px-2 py-1">
                                        <span className="font-mono text-sm">
                                            <ValueDisplay value={tx.quantity} />
                                        </span>
                                    </td>
                                    <td className="px-2 py-1">
                                        {tx.total ? <ValueDisplay value={tx.total} currency={baseCurrency} /> : '—'}
                                    </td>
                                    <td className="px-2 py-1">
                                        {onTransactionClick && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onTransactionClick(tx.transaction_id)}
                                            >
                                                <FiExternalLink />
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Actions */}
            <div className="mt-4 flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        // Navigate to first transaction
                        if (event.transactions[0] && onTransactionClick) {
                            onTransactionClick(event.transactions[0].transaction_id);
                        }
                    }}
                >
                    <FiArrowRight /> Go to Transaction
                </Button>
                {event.unit_id && onUnitClick && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onUnitClick(event.unit_id!)}
                    >
                        <FiArrowRight /> Go to Calculation Unit
                    </Button>
                )}
            </div>
        </SlidePanel>
    );
};

export default PnLImpactPanel;
