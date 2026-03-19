/**
 * UnitDetailSlidePanel — Slide panel showing calculation unit details.
 *
 * Fetches a single unit by ID and renders the same UnitDetailRow content
 * used in the expandable rows of the DataExplorerPanel.
 */

import React, { useEffect, useState } from 'react';
import { Badge, Box, Flex, Spinner, Text } from '@chakra-ui/react';
import { SlidePanel } from './SlidePanel';
import { UnitDetailRow } from './DataExplorerPanel';
import { API_URL } from '../../types';
import type { PnLCalculationUnit } from './types';

export interface UnitDetailSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    unitId: number | null;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}

const PATTERN_COLORS: Record<string, string> = {
    swap: 'purple',
    internal_transfer: 'blue',
    unmatched_internal_transfer: 'orange',
    flow: 'cyan',
    split: 'teal',
};

export const UnitDetailSlidePanel: React.FC<UnitDetailSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    unitId,
    baseCurrency,
    onTransactionClick,
}) => {
    const [unit, setUnit] = useState<PnLCalculationUnit | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || !unitId) {
            setUnit(null);
            return;
        }

        setIsLoading(true);
        setError(null);

        // Fetch the single unit from the units endpoint filtered by search on unit_id
        fetch(`${API_URL}/pnl/versions/${versionId}/units?search=${unitId}&limit=1`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                const items = data.items || data;
                const found = Array.isArray(items) ? items.find((u: any) => u.unit_id === unitId) : null;
                if (found) {
                    // Map backend response to frontend type
                    setUnit({
                        unit_id: found.unit_id,
                        unit_label: found.unit_label || '',
                        pattern: found.pattern,
                        date: found.timestamp,
                        transactions: (found.transactions || []).map((tx: any) => ({
                            id: tx.id,
                            date_time: tx.date_time,
                            account_id: tx.account_id,
                            account_name: tx.account_name,
                            source: tx.source,
                            transaction_type: tx.transaction_type,
                            source_transaction_type: tx.source_transaction_type,
                            direction: tx.direction,
                            asset_symbol: tx.asset?.symbol,
                            quantity: tx.quantity,
                            price: tx.price,
                            total: tx.total,
                            fee: tx.fee,
                            network: tx.network,
                        })),
                        legs: found.legs || [],
                        realized_entries: found.realized_entries,
                        realized_pnl_in_base: found.realized_pnl_in_base,
                        has_fees: found.has_fees,
                        total_fees_in_base: found.total_fees_in_base,
                        warnings: found.warnings,
                        event_ids: found.event_ids,
                    });
                } else {
                    setError('Calculation unit not found');
                }
                setIsLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setIsLoading(false);
            });
    }, [isOpen, unitId, versionId]);

    const title = unit
        ? `Unit #${unit.unit_id}`
        : unitId
            ? `Unit #${unitId}`
            : 'Unit Details';

    const titleIcon = unit?.pattern ? (
        <Badge size="sm" colorPalette={PATTERN_COLORS[unit.pattern] || 'gray'}>
            {unit.pattern.replace(/_/g, ' ')}
        </Badge>
    ) : undefined;

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title={title} titleIcon={titleIcon} width="1000px" zIndex={200}>
            {isLoading ? (
                <Flex align="center" justify="center" py={12} gap={2}>
                    <Spinner size="sm" />
                    <Text fontSize="sm" color="gray.400">Loading unit details…</Text>
                </Flex>
            ) : error ? (
                <Box textAlign="center" py={12}>
                    <Text fontSize="sm" color="red.500">{error}</Text>
                </Box>
            ) : unit ? (
                <UnitDetailRow
                    unit={unit}
                    baseCurrency={baseCurrency}
                    costLots={[]}
                    versionId={versionId}
                    onTransactionClick={onTransactionClick}
                />
            ) : null}
        </SlidePanel>
    );
};
