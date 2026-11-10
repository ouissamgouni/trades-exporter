import React, { useState } from 'react';
import { LuCircleCheck, LuCopy, LuExternalLink, LuTriangleAlert } from 'react-icons/lu';
import { Badge, Button, Textarea } from '../ui/primitives';
import { Tooltip } from '../ui/tooltip';
import { toaster } from '../ui/toaster';
import { formatAddress } from '../../utils/addressUtils';
import { tokenExplorerUrl } from '../../utils/explorers';
import { formatDateShort } from '../../utils/dateUtils';
import { isVerified, MappingStatus, MappingSuggestion, SuggestionReason } from '../../utils/mappingApi';

export const REASONS: Record<SuggestionReason, { label: string; hint: string }> = {
    known_contract: { label: 'Known contract', hint: 'This exact contract is already mapped from another source.' },
    official_deployment: { label: 'Official deployment', hint: 'CoinGecko lists this contract for the asset.' },
    unverified_contract: {
        label: 'Symbol only',
        hint: 'Only the symbol matches. Could be spam or a bridged/wrapped variant: check the contract first.',
    },
    known_symbol: { label: 'Mapped elsewhere', hint: 'The same symbol is already mapped in another source.' },
    exact_symbol: { label: 'Exact symbol', hint: 'An asset with exactly this symbol exists.' },
    known_label: { label: 'Mapped elsewhere', hint: 'The same address/label is already mapped in another source.' },
    exact_address: { label: 'Exact address', hint: "Matches the account's address." },
    exact_name: { label: 'Exact name', hint: "Matches the account's name." },
    similar: { label: 'Similar name', hint: 'Fuzzy match: review before accepting.' },
};

export const STATUS_META: Record<MappingStatus, { label: string; badge: 'green' | 'blue' | 'orange' | 'gray' }> = {
    suggested: { label: 'Suggested', badge: 'blue' },
    unmapped: { label: 'Unmapped', badge: 'orange' },
    mapped: { label: 'Mapped', badge: 'green' },
    ignored: { label: 'Ignored', badge: 'gray' },
};

export const StatusBadge: React.FC<{ status: MappingStatus }> = ({ status }) => (
    <Badge colorScheme={STATUS_META[status].badge}>{STATUS_META[status].label}</Badge>
);

/** Suggested target + why; verified ones get a one-click accept. */
export const SuggestionChip: React.FC<{
    suggestion: MappingSuggestion;
    onAccept?: () => void;
    busy?: boolean;
    compact?: boolean;
}> = ({ suggestion, onAccept, busy, compact }) => {
    const verified = isVerified(suggestion);
    const meta = suggestion.reason ? REASONS[suggestion.reason] : null;
    return (
        <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip content={`${meta?.hint ?? 'Suggested match'} (${Math.round(suggestion.confidence * 100)}%)`}>
                <span
                    className={`inline-flex min-w-0 items-center gap-1 border px-1.5 py-0.5 text-[11px] ${verified
                        ? 'border-green-200 bg-green-50 text-green-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                        }`}
                >
                    {verified
                        ? <LuCircleCheck size={12} aria-label="Verified" className="shrink-0" />
                        : <LuTriangleAlert size={12} aria-label="Needs review" className="shrink-0" />}
                    <span className="truncate font-semibold">{suggestion.name}</span>
                    {!compact && meta && <span className="shrink-0 opacity-75">· {meta.label}</span>}
                </span>
            </Tooltip>
            {onAccept && (
                <Button
                    size="xs"
                    variant={verified ? 'solid' : 'outline'}
                    colorScheme={verified ? 'green' : 'gray'}
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); onAccept(); }}
                >
                    {verified ? 'Accept' : 'Review'}
                </Button>
            )}
        </div>
    );
};

export const ContractChip: React.FC<{ network: string; contract: string; full?: boolean }> = ({ network, contract, full }) => {
    const url = tokenExplorerUrl(network, contract);
    const copy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(contract);
        toaster.success({ title: 'Contract copied' });
    };
    return (
        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-slate-500">
            <span className="shrink-0 bg-slate-100 px-1 font-sans font-medium text-slate-600">{network || 'n/a'}</span>
            <span className="truncate" title={contract}>{full ? contract : formatAddress(contract)}</span>
            <button type="button" aria-label="Copy contract" className="shrink-0 hover:text-slate-800" onClick={copy}>
                <LuCopy size={11} />
            </button>
            {url && (
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open in explorer"
                    className="shrink-0 hover:text-blue-600"
                    onClick={(e) => e.stopPropagation()}
                >
                    <LuExternalLink size={11} />
                </a>
            )}
        </span>
    );
};

export const UsageCell: React.FC<{ count: number; first?: string | null; last?: string | null }> = ({ count, first, last }) => (
    <div className="text-right">
        <div className={`text-xs tabular-nums ${count ? 'text-slate-800' : 'text-slate-400'}`}>{count.toLocaleString()}</div>
        {last && (
            <div className="text-[10px] text-slate-400" title={`First seen ${formatDateShort(first)}`}>
                {formatDateShort(last)}
            </div>
        )}
    </div>
);

/** Reason picker used when ignoring a raw asset/account (reason is required). */
export const IgnoreForm: React.FC<{
    reasons: string[];
    note?: React.ReactNode;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: (reason: string) => void;
}> = ({ reasons, note, busy, onCancel, onConfirm }) => {
    const [reason, setReason] = useState('');
    return (
        <div className="flex flex-col gap-2 border border-slate-200 bg-slate-50 p-2">
            {note && <div className="text-[11px] text-slate-600">{note}</div>}
            <div className="flex flex-wrap gap-1">
                {reasons.map((r) => (
                    <button
                        key={r}
                        type="button"
                        onClick={() => setReason(r)}
                        className={`border px-2 py-0.5 text-[11px] ${reason === r
                            ? 'border-blue-500 bg-blue-500 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                            }`}
                    >
                        {r}
                    </button>
                ))}
            </div>
            <Textarea
                aria-label="Ignore reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (required)"
                className="text-xs"
            />
            <div className="flex justify-end gap-2">
                <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button>
                <Button size="xs" colorScheme="gray" variant="solid" disabled={!reason.trim() || busy} onClick={() => onConfirm(reason.trim())}>
                    Ignore
                </Button>
            </div>
        </div>
    );
};

export const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex gap-2 text-xs">
        <span className="w-24 shrink-0 text-slate-500">{label}</span>
        <span className="min-w-0 flex-1 break-all text-slate-800">{children ?? '—'}</span>
    </div>
);
