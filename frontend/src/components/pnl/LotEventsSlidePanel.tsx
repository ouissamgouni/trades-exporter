/**
 * LotEventsSlidePanel — Slide panel wrapping the full CostLotEventsTable
 * with AUDIT preset for cross-unit lot event investigation.
 */

import React from 'react';
import { Box, Text } from '@chakra-ui/react';
import { SlidePanel } from './SlidePanel';
import { CostLotEventsTable, EVENT_TABLE_PRESETS } from './CostLotEventsTable';

export interface LotEventsSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    txFilterParams?: Record<string, string | undefined>;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}

export const LotEventsSlidePanel: React.FC<LotEventsSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    txFilterParams,
    onTransactionClick,
    onUnitClick,
}) => {
    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Cost Lot Events" width="900px">
            <Text fontSize="2xs" color="gray.500" mb={2}>
                Full audit trail of lot lifecycle events — opens, consumptions, settlements, adjustments.
            </Text>
            {isOpen && (
                <Box maxH="calc(100vh - 140px)" overflow="auto">
                    <CostLotEventsTable
                        {...EVENT_TABLE_PRESETS.AUDIT}
                        versionId={versionId}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                        onUnitClick={onUnitClick}
                        txFilterParams={txFilterParams}
                        defaultFiltersCollapsed={false}
                        storageKey="pnl_slide_lot_events"
                    />
                </Box>
            )}
        </SlidePanel>
    );
};
