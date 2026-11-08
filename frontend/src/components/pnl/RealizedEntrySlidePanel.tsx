/**
 * RealizedEntrySlidePanel — explains one realized P&L entry in both views:
 * Realized (proceeds − cost) and Taxable gain (proceeds − tax cost), the
 * "Deferred in" bridge between them, the lots consumed and the cost chain.
 */

import React, { useEffect, useState } from 'react';
import { SlidePanel } from './SlidePanel';
import { Spinner } from '../ui/primitives';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL } from '../../types';
import { formatDateLocale } from '../../utils/dateUtils';
import { FlatRow, flattenChain } from './CostBasisChainTooltip';
import type { CostBasisChainResponse } from './types';
import {
    InfoTip, TaxabilityPill, TERM_HELP, deferredInOf, realizedCostOf, realizedOf, type RealizedViewFields,
} from './pnlTerms';

interface LineageEntry extends RealizedViewFields {
    pnl_id: number;
    asset: { id: number; symbol: string; label?: string };
    qty: number;
    proceeds_in_base: number;
    taxable: boolean;
    transaction_id?: number;
    unit_id?: number;
    realized_at?: string;
    holding_period_days?: number;
    proceeds_price?: number;
    proceeds_price_source?: string;
}

interface LineageSlice {
    cost_lot_id: number;
    quantity: number;
    total_cost_in_base: number;
    economic_total_cost_in_base?: number | null;
    acquired_at: string;
    holding_period_days?: number;
}

interface LineageLot {
    cost_lot_id: number;
    account_name?: string;
    origin_transaction_id?: number;
}

interface LineageResponse {
    pnl: LineageEntry;
    source_lots: LineageLot[];
    consumed_slices: LineageSlice[];
}

export interface RealizedEntrySlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    pnlId: number | null;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    zIndex?: number;
}

const Equation: React.FC<{
    title: string;
    info: string;
    proceeds: number;
    costLabel: string;
    cost: number;
    resultLabel: string;
    result: number;
    currency: string;
    muted?: boolean;
}> = ({ title, info, proceeds, costLabel, cost, resultLabel, result, currency, muted }) => (
    <div className={`border p-3 ${muted ? 'border-slate-200 bg-slate-50' : 'border-blue-200 bg-blue-50/40'}`}>
        <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-slate-700">
            {title} <InfoTip text={info} />
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs tabular-nums">
            <span className="text-slate-500">Proceeds</span>
            <span className="text-right"><ValueDisplay value={proceeds} currency={currency} /></span>
            <span className="text-slate-500">− {costLabel}</span>
            <span className="text-right"><ValueDisplay value={cost} currency={currency} /></span>
            <span className="border-t border-slate-300 pt-0.5 font-semibold">= {resultLabel}</span>
            <span className={`border-t border-slate-300 pt-0.5 text-right font-semibold ${result >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                <ValueDisplay value={result} currency={currency} />
            </span>
        </div>
    </div>
);

export const RealizedEntrySlidePanel: React.FC<RealizedEntrySlidePanelProps> = ({
    isOpen, onClose, versionId, pnlId, baseCurrency, onTransactionClick, onUnitClick, zIndex = 300,
}) => {
    const [data, setData] = useState<LineageResponse | null>(null);
    const [chain, setChain] = useState<CostBasisChainResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || pnlId == null) return;
        setData(null);
        setChain(null);
        setError(null);
        Promise.all([
            fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/${pnlId}/lineage`).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            }),
            fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/${pnlId}/chain`).then(r => (r.ok ? r.json() : null)),
        ])
            .then(([lineage, ch]) => { setData(lineage); setChain(ch); })
            .catch(err => setError(err.message));
    }, [isOpen, pnlId, versionId]);

    const e = data?.pnl;
    const lotById = new Map((data?.source_lots ?? []).map(l => [l.cost_lot_id, l]));
    const deferredIn = e ? deferredInOf(e) : 0;
    const chainRows = chain ? flattenChain(chain.chain) : [];

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title={`Realized entry #${pnlId ?? ''}`} width="760px" zIndex={zIndex}>
            {error ? (
                <div className="py-12 text-center text-sm text-red-500">{error}</div>
            ) : !e ? (
                <div className="flex items-center justify-center gap-2 py-12">
                    <Spinner size="sm" /><span className="text-sm text-slate-400">Loading…</span>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {/* Header */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        <span className="font-semibold text-slate-800">
                            <ValueDisplay value={e.qty} /> {e.asset.symbol}
                        </span>
                        {e.realized_at && <span>· {formatDateLocale(e.realized_at)}</span>}
                        {e.holding_period_days != null && <span>· held {e.holding_period_days} d</span>}
                        <TaxabilityPill taxable={e.taxable} />
                        {e.transaction_id && (
                            <button type="button" className="text-blue-600 hover:underline" onClick={() => onTransactionClick?.(e.transaction_id!)}>
                                TX #{e.transaction_id}
                            </button>
                        )}
                        {e.unit_id && onUnitClick && (
                            <button type="button" className="text-blue-600 hover:underline" onClick={() => onUnitClick(e.unit_id!)}>
                                Unit #{e.unit_id}
                            </button>
                        )}
                    </div>

                    {/* Two views */}
                    <div className="grid grid-cols-2 gap-3">
                        <Equation
                            title="Realized" info={TERM_HELP.realized}
                            proceeds={e.proceeds_in_base} costLabel="Cost" cost={realizedCostOf(e)}
                            resultLabel="Realized" result={realizedOf(e)} currency={baseCurrency}
                        />
                        <Equation
                            title={e.taxable ? 'Taxable gain' : 'Tax view (not taxed now)'} info={TERM_HELP.taxable}
                            proceeds={e.proceeds_in_base} costLabel="Tax cost" cost={e.cost_basis_in_base}
                            resultLabel={e.taxable ? 'Taxable gain' : 'Tax P&L'} result={e.pnl_in_base}
                            currency={baseCurrency} muted={!e.taxable}
                        />
                    </div>

                    {/* Bridge */}
                    {deferredIn !== 0 ? (
                        <div className="border-l-4 border-blue-400 bg-blue-50 px-3 py-2 text-xs text-slate-700">
                            <div className="mb-1 flex items-center gap-1 font-semibold">
                                Deferred in: <ValueDisplay value={deferredIn} currency={baseCurrency} />
                                <span className={e.taxable ? 'text-red-600' : 'text-blue-600'}>({e.taxable ? 'released' : 'rolled over'})</span>
                                <InfoTip text={TERM_HELP.deferredIn} />
                            </div>
                            {e.taxable ? (
                                <>This gain was already counted in Realized at earlier tax-deferred swaps. It is taxed now:
                                    Taxable gain <ValueDisplay value={e.pnl_in_base} currency={baseCurrency} /> = Realized{' '}
                                    <ValueDisplay value={realizedOf(e)} currency={baseCurrency} /> + Deferred in{' '}
                                    <ValueDisplay value={deferredIn} currency={baseCurrency} />.</>
                            ) : (
                                <>This gain was already counted in Realized at earlier swaps and is not taxed here. It rolls over into
                                    the asset received, together with this entry&apos;s Realized{' '}
                                    <ValueDisplay value={realizedOf(e)} currency={baseCurrency} />, and will be taxed at a later taxable disposal.</>
                            )}
                        </div>
                    ) : (
                        <div className="text-[11px] text-slate-500">
                            Both views agree: the lots consumed carry no gain from earlier tax-deferred swaps.
                        </div>
                    )}

                    {/* Lots consumed */}
                    <div>
                        <div className="mb-1 text-xs font-semibold text-slate-700">Lots consumed ({data!.consumed_slices.length})</div>
                        <table className="w-full text-[11px] tabular-nums">
                            <thead className="text-[10px] uppercase text-slate-500">
                                <tr className="border-b border-slate-200">
                                    <th className="py-1 text-left">Lot</th>
                                    <th className="text-left">Account</th>
                                    <th className="text-left">Acquired</th>
                                    <th className="text-right">Qty</th>
                                    <th className="text-right">Cost</th>
                                    <th className="text-right">Tax cost</th>
                                    <th className="text-right">Origin TX</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data!.consumed_slices.map(sl => {
                                    const lot = lotById.get(sl.cost_lot_id);
                                    return (
                                        <tr key={`${sl.cost_lot_id}-${sl.acquired_at}`} className="border-b border-slate-100">
                                            <td className="py-1 font-mono text-slate-500">#{sl.cost_lot_id}</td>
                                            <td>{lot?.account_name ?? '—'}</td>
                                            <td>{formatDateLocale(sl.acquired_at)}</td>
                                            <td className="text-right"><ValueDisplay value={sl.quantity} /></td>
                                            <td className="text-right"><ValueDisplay value={sl.economic_total_cost_in_base ?? sl.total_cost_in_base} currency={baseCurrency} /></td>
                                            <td className="text-right"><ValueDisplay value={sl.total_cost_in_base} currency={baseCurrency} /></td>
                                            <td className="text-right">
                                                {lot?.origin_transaction_id ? (
                                                    <button type="button" className="text-blue-600 hover:underline" onClick={() => onTransactionClick?.(lot.origin_transaction_id!)}>
                                                        #{lot.origin_transaction_id}
                                                    </button>
                                                ) : '—'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Cost chain */}
                    {chainRows.length > 0 && (
                        <div>
                            <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-700">
                                Cost chain (back to the original purchase)
                                <InfoTip text="Each step shows the cost per unit when the lot was received, and the tax cost when it differs (carried over through tax-deferred swaps)." />
                            </div>
                            <div className="border border-slate-200">
                                {chainRows.map(node => (
                                    <FlatRow key={node.lot_id} node={node} isOrigin={node.children.length === 0}
                                        baseCurrency={baseCurrency} onTransactionClick={onTransactionClick} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </SlidePanel>
    );
};
