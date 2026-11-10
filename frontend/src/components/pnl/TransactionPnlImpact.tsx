/**
 * TransactionPnlImpact — what one transaction did in a P&L calculation:
 * unit, realized entries, lots created / consumed, fees and warnings.
 * Defaults to the latest calculation; another one can be picked.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { LuLocateFixed, LuRefreshCw, LuTriangleAlert } from 'react-icons/lu';
import { Badge, Button, Spinner } from '../ui/primitives';
import { ValueDisplay } from '../ValueDisplay';
import { Tooltip } from '../ui/tooltip';
import { API_URL } from '../../types';
import { formatDateLocale, formatDateTimeLocale } from '../../utils/dateUtils';
import { pnlLocatePath } from '../../utils/pnlLocate';
import { RealizedEntrySlidePanel } from './RealizedEntrySlidePanel';
import { UnitDetailSlidePanel } from './UnitDetailSlidePanel';
import {
    DeferredInValue, InfoTip, TaxabilityPill, TaxableGainValue, TERM_HELP, realizedOf,
    type RealizedViewFields,
} from './pnlTerms';

interface VersionItem {
    version_id: number;
    created_at: string;
    status: string;
    base_currency_symbol?: string;
}

interface ImpactEntry extends RealizedViewFields {
    pnl_id?: number | null;
    asset: { id: number; symbol: string };
    qty: number;
    disposal_taxable: boolean;
    is_fee?: boolean;
}

interface ImpactLot {
    cost_lot_id: number;
    asset: { id: number; symbol: string };
    account_name?: string;
    qty_original: number;
    qty_remaining: number;
    total_cost_in_base: number;
    unit_cost_in_base: number;
    economic_unit_cost_in_base?: number | null;
    origin_transaction_id?: number;
}

interface ImpactSlice {
    cost_lot_id: number;
    asset?: { symbol: string };
    quantity: number;
    total_cost_in_base: number;
    economic_total_cost_in_base?: number | null;
    acquired_at: string;
}

interface Impact {
    version_id: number;
    included: boolean;
    excluded_reason?: 'pending' | 'invalid' | 'after_calculation' | 'not_processed' | null;
    stale: boolean;
    unit_id?: number;
    unit_pattern?: string;
    leg_types: string[];
    realized_entries: ImpactEntry[];
    lots_created: ImpactLot[];
    consumed_slices: ImpactSlice[];
    consumed_lots: ImpactLot[];
    fees: { fee_in_base: number; asset?: { symbol: string } }[];
    warnings: { warning_type: string; message: string }[];
}

const EXCLUDED_TEXT: Record<string, string> = {
    pending: 'Not in this calculation: the transaction is pending review. Mark it valid and recalculate.',
    invalid: 'Not in this calculation: the transaction is rejected.',
    after_calculation: 'Not in this calculation: it is dated after the calculation ran. Recalculate to include it.',
    not_processed: 'Not in this calculation (it was added or changed after the run). Recalculate to include it.',
};

const SubTitle: React.FC<{ children: React.ReactNode; info?: string }> = ({ children, info }) => (
    <div className="mb-0.5 mt-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {children}{info && <InfoTip text={info} />}
    </div>
);

export const TransactionPnlImpact: React.FC<{
    txId: number;
    txDateTime?: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ txId, txDateTime, onTransactionClick }) => {
    const inRouter = useInRouterContext();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- inRouter is stable for a mounted component
    const navigate = inRouter ? useNavigate() : null;

    const [versions, setVersions] = useState<VersionItem[] | null>(null);
    const [versionId, setVersionId] = useState<number | null>(null);
    const [impact, setImpact] = useState<Impact | null>(null);
    const [loading, setLoading] = useState(false);
    const [recalculating, setRecalculating] = useState(false);
    const [entryPanelId, setEntryPanelId] = useState<number | null>(null);
    const [unitPanelId, setUnitPanelId] = useState<number | null>(null);

    const loadVersions = useCallback(async (selectLatest: boolean) => {
        const res = await fetch(`${API_URL}/pnl/versions`);
        if (!res.ok) return;
        const list: VersionItem[] = (await res.json()).sort((a: VersionItem, b: VersionItem) => b.version_id - a.version_id);
        setVersions(list);
        if (list.length > 0) setVersionId(prev => (selectLatest || prev == null ? list[0].version_id : prev));
    }, []);

    useEffect(() => { loadVersions(false).catch(() => setVersions([])); }, [loadVersions]);

    useEffect(() => {
        if (versionId == null) return;
        setLoading(true);
        fetch(`${API_URL}/pnl/versions/${versionId}/transactions/${txId}/impact`)
            .then(r => (r.ok ? r.json() : null))
            .then(setImpact)
            .catch(() => setImpact(null))
            .finally(() => setLoading(false));
    }, [versionId, txId]);

    const recalculate = async () => {
        setRecalculating(true);
        try {
            await fetch(`${API_URL}/pnl/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const st = await fetch(`${API_URL}/pnl/calculation-status`).then(r => r.json()).catch(() => null);
                if (st && st.status !== 'calculating') break;
            }
            await loadVersions(true);
        } finally {
            setRecalculating(false);
        }
    };

    const latestId = versions?.[0]?.version_id;
    const currency = versions?.find(v => v.version_id === versionId)?.base_currency_symbol ?? '';
    const lotById = useMemo(() => new Map((impact?.consumed_lots ?? []).map(l => [l.cost_lot_id, l])), [impact]);

    const locate = () => {
        const path = pnlLocatePath(txId, txDateTime);
        if (navigate) navigate(path);
        else window.location.assign(path);
    };

    if (versions === null) {
        return <div className="flex items-center gap-2 py-2 text-xs text-slate-400"><Spinner size="xs" /> Loading calculations…</div>;
    }
    if (versions.length === 0) {
        return <div className="py-2 text-xs text-slate-500">No P&L calculation yet.</div>;
    }

    return (
        <div className="text-xs">
            {/* Calculation picker + actions */}
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500">Calculation</span>
                <select
                    aria-label="P&L calculation"
                    className="border border-slate-300 px-1 py-0.5 text-xs"
                    value={versionId ?? ''}
                    onChange={e => setVersionId(Number(e.target.value))}
                >
                    {versions.map(v => (
                        <option key={v.version_id} value={v.version_id}>
                            #{v.version_id} · {formatDateTimeLocale(v.created_at)}{v.version_id === latestId ? ' (latest)' : ''}
                        </option>
                    ))}
                </select>
                <Tooltip content={versionId === latestId ? 'Open the P&L audit table around this transaction' : 'The P&L page shows the latest calculation'}>
                    <span>
                        <Button size="xs" variant="outline" onClick={locate} disabled={versionId !== latestId || !impact?.included}>
                            <LuLocateFixed size={11} /> Locate in P&L audit
                        </Button>
                    </span>
                </Tooltip>
            </div>

            {impact?.stale && (
                <div className="mt-2 flex items-center gap-2 border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
                    <LuTriangleAlert size={12} /> Edited after this calculation: figures may be out of date.
                    <Button size="xs" variant="outline" className="ml-auto" onClick={recalculate} disabled={recalculating}>
                        <LuRefreshCw size={11} /> {recalculating ? 'Recalculating…' : 'Recalculate'}
                    </Button>
                </div>
            )}

            {loading || !impact ? (
                <div className="flex items-center gap-2 py-2 text-slate-400"><Spinner size="xs" /> Loading impact…</div>
            ) : !impact.included ? (
                <div className="mt-2 flex items-center gap-2 bg-slate-50 px-2 py-1.5 text-slate-600">
                    {EXCLUDED_TEXT[impact.excluded_reason ?? 'not_processed']}
                    {(impact.excluded_reason === 'after_calculation' || impact.excluded_reason === 'not_processed') && (
                        <Button size="xs" variant="outline" className="ml-auto" onClick={recalculate} disabled={recalculating}>
                            <LuRefreshCw size={11} /> {recalculating ? 'Recalculating…' : 'Recalculate'}
                        </Button>
                    )}
                </div>
            ) : (
                <>
                    {/* Unit */}
                    <SubTitle>Unit</SubTitle>
                    <div className="flex items-center gap-2">
                        {impact.unit_id != null && (
                            <button type="button" className="text-blue-600 hover:underline" onClick={() => setUnitPanelId(impact.unit_id!)}>
                                Unit #{impact.unit_id}
                            </button>
                        )}
                        {impact.unit_pattern && <Badge className="text-[10px]">{impact.unit_pattern.replace(/_/g, ' ')}</Badge>}
                        <span className="text-slate-500">role: {impact.leg_types.join(', ') || '—'}</span>
                    </div>

                    {/* Realized */}
                    <SubTitle info={TERM_HELP.realized}>Realized ({impact.realized_entries.length})</SubTitle>
                    {impact.realized_entries.length === 0 ? (
                        <div className="text-slate-400">No disposal in this transaction.</div>
                    ) : (
                        <table className="w-full tabular-nums">
                            <thead className="text-[10px] text-slate-500">
                                <tr>
                                    <th className="text-left">Asset</th>
                                    <th className="text-right">Realized</th>
                                    <th className="text-right">Taxable gain</th>
                                    <th className="text-right">Deferred in</th>
                                    <th className="text-center">Tax</th>
                                </tr>
                            </thead>
                            <tbody>
                                {impact.realized_entries.map((e, i) => (
                                    <tr
                                        key={e.pnl_id ?? i}
                                        className={e.pnl_id != null ? 'cursor-pointer hover:bg-blue-50' : undefined}
                                        title={e.pnl_id != null ? 'Explain this entry' : undefined}
                                        onClick={e.pnl_id != null ? () => setEntryPanelId(e.pnl_id!) : undefined}
                                    >
                                        <td><ValueDisplay value={e.qty} /> {e.asset.symbol}{e.is_fee ? ' (fee)' : ''}</td>
                                        <td className={`text-right font-medium ${realizedOf(e) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                            <ValueDisplay value={realizedOf(e)} currency={currency} />
                                        </td>
                                        <td className="text-right"><TaxableGainValue entry={e} taxable={e.disposal_taxable} currency={currency} /></td>
                                        <td className="text-right"><DeferredInValue entry={e} taxable={e.disposal_taxable} currency={currency} /></td>
                                        <td className="text-center"><TaxabilityPill taxable={e.disposal_taxable} isFee={e.is_fee} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {/* Lots created */}
                    {impact.lots_created.length > 0 && (
                        <>
                            <SubTitle info={`${TERM_HELP.cost} Tax cost: ${TERM_HELP.taxCost}`}>Lots created</SubTitle>
                            <table className="w-full tabular-nums">
                                <thead className="text-[10px] text-slate-500">
                                    <tr><th className="text-left">Lot</th><th className="text-right">Qty</th><th className="text-right">Cost</th><th className="text-right">Tax cost</th><th className="text-right">Left now</th></tr>
                                </thead>
                                <tbody>
                                    {impact.lots_created.map(l => (
                                        <tr key={l.cost_lot_id}>
                                            <td>#{l.cost_lot_id} {l.asset.symbol} <span className="text-slate-400">{l.account_name}</span></td>
                                            <td className="text-right"><ValueDisplay value={l.qty_original} /></td>
                                            <td className="text-right"><ValueDisplay value={l.qty_original * (l.economic_unit_cost_in_base ?? l.unit_cost_in_base)} currency={currency} /></td>
                                            <td className="text-right"><ValueDisplay value={l.total_cost_in_base} currency={currency} /></td>
                                            <td className="text-right">
                                                {l.qty_remaining > 0 ? <ValueDisplay value={l.qty_remaining} /> : <span className="text-slate-400">used up</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </>
                    )}

                    {/* Lots consumed */}
                    {impact.consumed_slices.length > 0 && (
                        <>
                            <SubTitle>Lots consumed</SubTitle>
                            <table className="w-full tabular-nums">
                                <thead className="text-[10px] text-slate-500">
                                    <tr><th className="text-left">Lot</th><th className="text-right">Qty</th><th className="text-right">Cost</th><th className="text-right">Tax cost</th><th className="text-right">From TX</th></tr>
                                </thead>
                                <tbody>
                                    {impact.consumed_slices.map((sl, i) => {
                                        const lot = lotById.get(sl.cost_lot_id);
                                        return (
                                            <tr key={`${sl.cost_lot_id}-${i}`}>
                                                <td>#{sl.cost_lot_id} {sl.asset?.symbol} <span className="text-slate-400">{formatDateLocale(sl.acquired_at)}</span></td>
                                                <td className="text-right"><ValueDisplay value={sl.quantity} /></td>
                                                <td className="text-right"><ValueDisplay value={sl.economic_total_cost_in_base ?? sl.total_cost_in_base} currency={currency} /></td>
                                                <td className="text-right"><ValueDisplay value={sl.total_cost_in_base} currency={currency} /></td>
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
                        </>
                    )}

                    {/* Fees */}
                    {impact.fees.length > 0 && (
                        <>
                            <SubTitle>Fees</SubTitle>
                            {impact.fees.map((f, i) => (
                                <div key={i} className="flex justify-between">
                                    <span>{f.asset?.symbol ?? '—'}</span>
                                    <span className="text-orange-700"><ValueDisplay value={f.fee_in_base} currency={currency} /></span>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Warnings */}
                    {impact.warnings.length > 0 && (
                        <>
                            <SubTitle>Warnings</SubTitle>
                            {impact.warnings.map((w, i) => (
                                <div key={i} className="mb-1 border-l-2 border-orange-400 bg-orange-50 px-2 py-1">
                                    <span className="font-medium text-orange-800">{w.warning_type}</span>
                                    <div className="text-slate-700">{w.message}</div>
                                </div>
                            ))}
                        </>
                    )}
                </>
            )}

            {versionId != null && (
                <>
                    <RealizedEntrySlidePanel
                        isOpen={entryPanelId !== null}
                        onClose={() => setEntryPanelId(null)}
                        versionId={versionId}
                        pnlId={entryPanelId}
                        baseCurrency={currency}
                        onTransactionClick={onTransactionClick}
                        zIndex={2100}
                    />
                    <UnitDetailSlidePanel
                        isOpen={unitPanelId !== null}
                        onClose={() => setUnitPanelId(null)}
                        versionId={versionId}
                        unitId={unitPanelId}
                        baseCurrency={currency}
                        onTransactionClick={onTransactionClick}
                        zIndex={2100}
                    />
                </>
            )}
        </div>
    );
};
