/**
 * TransactionsSlidePanel — Slide panel showing transactions included/excluded
 * in the PnL calculation version with a toggle to switch between the two views.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Flex, Spinner, Text } from '@chakra-ui/react';
import { FiCheck, FiX } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { TransactionsTable } from '../TransactionsTable';
import { TransactionFilterState, defaultFilterState } from '../TransactionFilters';
import { API_URL } from '../../types';

export interface TransactionsSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    /** Context filters from the InvestigationView (dates, accounts, assets, etc.) */
    contextFilters?: Partial<TransactionFilterState>;
}

export const TransactionsSlidePanel: React.FC<TransactionsSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    onTransactionClick,
    contextFilters,
}) => {
    const [view, setView] = useState<'included' | 'excluded'>('included');
    const [includedCount, setIncludedCount] = useState<number | null>(null);
    const [excludedCount, setExcludedCount] = useState<number | null>(null);

    // Fetch counts for both included/excluded
    useEffect(() => {
        if (!isOpen) return;

        const fetchCount = async (status: 'included' | 'excluded') => {
            try {
                const res = await fetch(
                    `${API_URL}/transactions?pnl_cal_version=${versionId}&pnl_cal_inclusions_status=${status}&limit=1`
                );
                const data = await res.json();
                return data?.metadata?.filtered_count ?? data?.total ?? 0;
            } catch {
                return 0;
            }
        };

        fetchCount('included').then(setIncludedCount);
        fetchCount('excluded').then(setExcludedCount);
    }, [isOpen, versionId]);

    // Build controlled filter state with version + inclusion + context filters
    const [filters, setFilters] = useState<TransactionFilterState>({
        ...defaultFilterState,
        reviewStatus: [],
    });

    const effectiveFilters = useMemo<TransactionFilterState>(() => ({
        ...filters,
        // Merge context filters (dates, accounts, assets, etc.)
        ...contextFilters,
        // Always override these — they're controlled by this panel
        versionId: String(versionId),
        inclusionStatus: view,
    }), [filters, contextFilters, versionId, view]);

    const resetFilters = useMemo<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: [],
        ...contextFilters,
        versionId: String(versionId),
        inclusionStatus: view,
    }), [contextFilters, versionId, view]);

    const handleFiltersChange = useCallback((newFilters: TransactionFilterState) => {
        // Preserve our controlled versionId and inclusionStatus
        setFilters(prev => ({
            ...newFilters,
            versionId: undefined,
            inclusionStatus: undefined,
        }));
    }, []);

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Transactions" width="1000px">
            {/* Included / Excluded toggle */}
            <Flex gap={2} mb={3} align="center">
                <Button
                    size="xs"
                    variant={view === 'included' ? 'solid' : 'outline'}
                    colorPalette="green"
                    onClick={() => setView('included')}
                >
                    <FiCheck />
                    Included {includedCount !== null ? `(${includedCount})` : ''}
                </Button>
                <Button
                    size="xs"
                    variant={view === 'excluded' ? 'solid' : 'outline'}
                    colorPalette="red"
                    onClick={() => setView('excluded')}
                >
                    <FiX />
                    Excluded {excludedCount !== null ? `(${excludedCount})` : ''}
                </Button>
                {(includedCount === null || excludedCount === null) && (
                    <Spinner size="xs" color="gray.400" />
                )}
            </Flex>

            {/* TransactionsTable */}
            {isOpen && (
                <Box maxH="calc(100vh - 160px)" overflow="auto">
                    <TransactionsTable
                        tableId={`pnl-audit-tx-${view}`}
                        filters={effectiveFilters}
                        onFiltersChange={handleFiltersChange}
                        resetFilters={resetFilters}
                        showFilters={true}
                        defaultFiltersCollapsed={true}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                    />
                </Box>
            )}
        </SlidePanel>
    );
};
