/**
 * CostBasisChainTooltip — Click-to-open popover showing the full backward
 * cost basis chain for a lot, realized P&L entry, or cost lot event.
 *
 * Each chain node is rendered as a flat row (no tree nesting) to save space.
 * Clicking the trigger opens the popover; clicking outside closes it.
 */

import React, { useEffect, useState } from 'react';
import { Badge, Box, Flex, Portal, Popover as ChakraPopover, Text } from '@chakra-ui/react';
import { FiLink } from 'react-icons/fi';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL } from '../../types';
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

const COST_SOURCE_PALETTE: Record<string, string> = {
    fmv: 'cyan',
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
        <Flex
            align="center"
            gap={1.5}
            py={1}
            px={2}
            borderBottom="1px solid"
            borderColor="gray.100"
            _hover={{ bg: 'gray.50' }}
        >
            <Text fontSize="2xs" minW="16px" textAlign="center">{icon}</Text>
            <Text fontSize="2xs" color="gray.500" minW="62px">{date}</Text>
            {node.asset_symbol && (
                <Badge size="xs" colorPalette="gray" fontFamily="mono">{node.asset_symbol}</Badge>
            )}
            <Text fontSize="2xs" color="gray.700" fontFamily="mono" minW="58px" textAlign="right">
                {Number(node.qty).toFixed(4)}
            </Text>
            <Text fontSize="2xs" color="gray.400" mx={0.5}>@</Text>
            <Text fontSize="2xs" color="gray.700" minW="48px" textAlign="right">
                <ValueDisplay value={node.unit_cost} currency={baseCurrency} />
            </Text>
            {node.account_name && (
                <Text fontSize="2xs" color="gray.500" ml={1} truncate maxW="80px">
                    {node.account_name}
                </Text>
            )}
            {node.cost_source && (
                <Badge size="xs" colorPalette={COST_SOURCE_PALETTE[node.cost_source] ?? 'gray'} ml={0.5}>
                    {node.cost_source}
                </Badge>
            )}
            {isOrigin && (
                <Badge size="xs" colorPalette="green" variant="solid" ml={0.5}>origin</Badge>
            )}
            {node.transaction_id && onTransactionClick && (
                <Text
                    fontSize="2xs"
                    color="blue.500"
                    cursor="pointer"
                    ml="auto"
                    onClick={(e) => {
                        e.stopPropagation();
                        onTransactionClick(node.transaction_id!);
                    }}
                    _hover={{ textDecoration: 'underline' }}
                >
                    #{node.transaction_id}
                </Text>
            )}
        </Flex>
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
        <ChakraPopover.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
            <ChakraPopover.Trigger asChild>
                <Box display="inline-block" cursor="pointer">
                    {children}
                </Box>
            </ChakraPopover.Trigger>
            <Portal>
                <ChakraPopover.Positioner>
                    <ChakraPopover.Content
                        bg="white"
                        borderRadius="lg"
                        shadow="xl"
                        border="1px solid"
                        borderColor="gray.200"
                        w="580px"
                        maxH="420px"
                        overflow="hidden"
                    >
                        <ChakraPopover.Body p={0}>
                            {/* Header */}
                            <Flex
                                justify="space-between"
                                align="center"
                                px={3}
                                py={2}
                                borderBottom="1px solid"
                                borderColor="gray.100"
                                bg="gray.50"
                            >
                                <Flex align="center" gap={1}>
                                    <FiLink size={12} color="var(--chakra-colors-gray-500)" />
                                    <Text fontSize="xs" fontWeight="semibold" color="gray.700">
                                        Cost Basis Chain
                                    </Text>
                                </Flex>
                                {data && (
                                    <Text fontSize="2xs" color="gray.400">
                                        {totalNodes} step{totalNodes !== 1 ? 's' : ''} · depth {data.depth}
                                    </Text>
                                )}
                            </Flex>
                            {/* Body */}
                            <Box overflowY="auto" maxH="360px">
                                {loading ? (
                                    <Text fontSize="xs" color="gray.400" p={3}>Loading chain…</Text>
                                ) : error ? (
                                    <Text fontSize="xs" color="red.500" p={3}>Error: {error}</Text>
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
                                    <Text fontSize="xs" color="gray.400" p={3}>No chain data</Text>
                                ) : null}
                            </Box>
                        </ChakraPopover.Body>
                    </ChakraPopover.Content>
                </ChakraPopover.Positioner>
            </Portal>
        </ChakraPopover.Root>
    );
};
