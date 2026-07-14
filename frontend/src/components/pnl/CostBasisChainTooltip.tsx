/**
 * CostBasisChainTooltip — Click-to-open popover showing the full backward
 * cost basis chain for a lot, realized P&L entry, or cost lot event.
 *
 * Each chain node is rendered as a flat row (no tree nesting) to save space.
 * Clicking the trigger opens the popover; clicking outside closes it.
 */

import React, { useEffect, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { FiLink } from 'react-icons/fi';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL } from '../../types';
import { Badge, type BadgeColorScheme } from '../ui/primitives';
import type { CostBasisChainNode, CostBasisChainResponse } from './types';

// Re-export for consumers
export type { CostBasisChainNode, CostBasisChainResponse } from './types';

// ============================================================================
// TX-type icon mapping
// ============================================================================

const TX_TYPE_ICON: Record<string, string> = {
    buy: '🟢',
    sell: '🔴',
    transfer: '🔄',
    swap: '🔀',
    split: '✂️',
    deposit: '📥',
    withdrawal: '📤',
    trade: '💱',
    airdrop: '🎁',
    staking_reward: '🏆',
    fee: '💸',
    internal_transfer: '🔄',
};

const COST_SOURCE_PALETTE: Record<string, BadgeColorScheme> = {
    fmv: 'blue',
    inherited: 'blue',
    proceeds: 'green',
    provisional: 'orange',
    base_currency: 'gray',
};

// ============================================================================
// Flatten tree into rows
// ============================================================================

function flattenChain(chain: CostBasisChainNode[]): CostBasisChainNode[] {
    const rows: CostBasisChainNode[] = [];
    const walk = (nodes: CostBasisChainNode[]) => {
        for (const n of nodes) {
            rows.push(n);
            walk(n.children);
        }
    };
    walk(chain);
    return rows;
}

function countNodes(chain: CostBasisChainNode[]): number {
    return chain.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}

// ============================================================================
// Flat row renderer
// ============================================================================

interface FlatRowProps {
    node: CostBasisChainNode;
    isOrigin: boolean;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}

const FlatRow: React.FC<FlatRowProps> = ({ node, isOrigin, baseCurrency, onTransactionClick }) => {
    const icon = TX_TYPE_ICON[node.transaction_type ?? ''] || TX_TYPE_ICON[node.unit_pattern ?? ''] || '📦';
    const date = node.timestamp ? new Date(node.timestamp).toLocaleDateString() : '—';

    return (
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-2 py-1 hover:bg-slate-50">
            <span className="min-w-[16px] text-center text-[10px]">{icon}</span>
            <span className="min-w-[62px] text-[10px] text-slate-500">{date}</span>
            {node.asset_symbol && (
                <Badge colorScheme="gray" className="font-mono">{node.asset_symbol}</Badge>
            )}
            <span className="min-w-[58px] text-right font-mono text-[10px] text-slate-700">
                {Number(node.qty).toFixed(4)}
            </span>
            <span className="mx-0.5 text-[10px] text-slate-400">@</span>
            <span className="min-w-[48px] text-right text-[10px] text-slate-700">
                <ValueDisplay value={node.unit_cost} currency={baseCurrency} />
            </span>
            {node.account_name && (
                <span className="ml-1 max-w-[80px] truncate text-[10px] text-slate-500">
                    {node.account_name}
                </span>
            )}
            {node.cost_source && (
                <Badge colorScheme={COST_SOURCE_PALETTE[node.cost_source] ?? 'gray'} className="ml-0.5">
                    {node.cost_source}
                </Badge>
            )}
            {isOrigin && (
                <Badge colorScheme="green" className="ml-0.5 bg-green-600 text-white">origin</Badge>
            )}
            {node.transaction_id && onTransactionClick && (
                <span
                    className="ml-auto cursor-pointer text-[10px] text-blue-500 hover:underline"
                    onClick={(e) => {
                        e.stopPropagation();
                        onTransactionClick(node.transaction_id!);
                    }}
                >
                    #{node.transaction_id}
                </span>
            )}
        </div>
    );
};


// ============================================================================
// Main popover component (click-to-stick, click-outside-to-close)
// ============================================================================

export interface CostBasisChainTooltipProps {
    /** Provide exactly ONE of lotId, pnlId, eventId */
    lotId?: number;
    pnlId?: number;
    eventId?: number;
    versionId: number;
    baseCurrency: string;
    children: React.ReactNode;
    onTransactionClick?: (txId: number) => void;
}

export const CostBasisChainTooltip: React.FC<CostBasisChainTooltipProps> = ({
    lotId, pnlId, eventId, versionId, baseCurrency, children, onTransactionClick,
}) => {
    const [data, setData] = useState<CostBasisChainResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);
    const [open, setOpen] = useState(false);

    const fetchChain = async () => {
        if (hasFetched || loading) return;
        setLoading(true);
        setHasFetched(true);
        try {
            let url = '';
            if (lotId != null) {
                url = `${API_URL}/pnl/versions/${versionId}/lots/${lotId}/chain`;
            } else if (pnlId != null) {
                url = `${API_URL}/pnl/versions/${versionId}/realized-pnl/${pnlId}/chain`;
            } else if (eventId != null) {
                url = `${API_URL}/pnl/versions/${versionId}/events/${eventId}/chain`;
            } else {
                throw new Error('No lotId, pnlId, or eventId provided');
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch chain');
            setData(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error');
        } finally {
            setLoading(false);
        }
    };

    // Fetch when opened
    useEffect(() => {
        if (open) fetchChain();
    }, [open]);

    const totalNodes = data ? countNodes(data.chain) : 0;
    const flatRows = data ? flattenChain(data.chain) : [];

    return (
        <RadixPopover.Root open={open} onOpenChange={setOpen}>
            <RadixPopover.Trigger asChild>
                <div className="inline-block cursor-pointer">
                    {children}
                </div>
            </RadixPopover.Trigger>
            <RadixPopover.Portal>
                <RadixPopover.Content
                    sideOffset={4}
                    className="z-50 w-[580px] max-h-[420px] overflow-hidden border border-slate-200 bg-white shadow-xl"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="flex items-center gap-1">
                            <span className="text-slate-500"><FiLink size={12} /></span>
                            <span className="text-xs font-semibold text-slate-700">
                                Cost Basis Chain
                            </span>
                        </div>
                        {data && (
                            <span className="text-[10px] text-slate-400">
                                {totalNodes} step{totalNodes !== 1 ? 's' : ''} · depth {data.depth}
                            </span>
                        )}
                    </div>
                    {/* Body */}
                    <div className="max-h-[360px] overflow-y-auto">
                        {loading ? (
                            <span className="block p-3 text-xs text-slate-400">Loading chain…</span>
                        ) : error ? (
                            <span className="block p-3 text-xs text-red-500">Error: {error}</span>
                        ) : flatRows.length > 0 ? (
                            flatRows.map((node) => (
                                <FlatRow
                                    key={node.lot_id}
                                    node={node}
                                    isOrigin={node.children.length === 0}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                />
                            ))
                        ) : data ? (
                            <span className="block p-3 text-xs text-slate-400">No chain data</span>
                        ) : null}
                    </div>
                </RadixPopover.Content>
            </RadixPopover.Portal>
        </RadixPopover.Root>
    );
};
