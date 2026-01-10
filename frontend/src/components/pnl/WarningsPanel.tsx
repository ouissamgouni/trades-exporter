/**
 * Warnings Panel
 * 
 * Shows all warnings with severity levels and actions.
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Text,
} from '@chakra-ui/react';
import { FiExternalLink, FiAlertTriangle, FiAlertCircle, FiInfo, FiPlus } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { PnLWarningItem, WarningLevel } from './types';
import { AddManualPriceDialog } from './AddManualPriceDialog';
import { getWarningTypeConfig } from './warningStyles';

interface WarningsPanelProps {
    warnings: PnLWarningItem[];
    onClose: () => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onAssetClick?: (assetId: number) => void;
    // Manual price entry support
    quoteAssetId?: number;  // Base currency asset ID
    baseCurrency?: string;  // Base currency symbol (e.g., "EUR")
    onPriceAdded?: (assetId: number, warningId: string) => void;  // Callback after manual price is saved
    assets?: Array<{ id: number; name: string }>;  // Asset lookup for name display
}

const getWarningIcon = (level: WarningLevel) => {
    switch (level) {
        case 'error':
            return <FiAlertCircle size={18} color="red" />;
        case 'warning':
            return <FiAlertTriangle size={18} color="orange" />;
        case 'info':
        default:
            return <FiInfo size={18} color="blue" />;
    }
};

const getWarningColor = (level: WarningLevel) => {
    switch (level) {
        case 'error':
            return { bg: 'red.50', border: 'red.200' };
        case 'warning':
            return { bg: 'orange.50', border: 'orange.200' };
        case 'info':
        default:
            return { bg: 'blue.50', border: 'blue.200' };
    }
};

export const WarningsPanel: React.FC<WarningsPanelProps> = ({
    warnings,
    onClose,
    onTransactionClick,
    onUnitClick,
    onAssetClick,
    quoteAssetId,
    baseCurrency,
    onPriceAdded,
    assets,
}) => {
    const [levelFilter, setLevelFilter] = useState<WarningLevel | 'all'>('all');

    // State for manual price dialog
    const [dialogOpen, setDialogOpen] = useState(false);
    const [selectedWarning, setSelectedWarning] = useState<PnLWarningItem | null>(null);

    // Check if warning is a price-related warning that can have manual price added
    const isPriceWarning = (warning: PnLWarningItem) =>
        (warning.warning_type === 'missing_price' || warning.warning_type === 'stale_price') &&
        warning.asset_id != null;

    // Get asset name from assets list or fallback to ID
    const getAssetName = (assetId: number) => {
        const asset = assets?.find(a => a.id === assetId);
        return asset?.name || `Asset #${assetId}`;
    };

    // Get default date for price from warning details
    const getDefaultDateFromWarning = (warning: PnLWarningItem): string => {
        const transactionDate = warning.details?.transaction_date as string | undefined;
        if (transactionDate) {
            return transactionDate;
        }
        return new Date().toISOString();
    };

    const handleAddPriceClick = (warning: PnLWarningItem) => {
        setSelectedWarning(warning);
        setDialogOpen(true);
    };

    const handlePriceSaved = () => {
        if (selectedWarning && selectedWarning.asset_id && onPriceAdded) {
            onPriceAdded(selectedWarning.asset_id, selectedWarning.id);
        }
        setDialogOpen(false);
        setSelectedWarning(null);
    };

    const errorCount = warnings.filter(w => w.level === 'error').length;
    const warningCount = warnings.filter(w => w.level === 'warning').length;
    const infoCount = warnings.filter(w => w.level === 'info').length;

    const filtered = warnings.filter((w) => {
        if (levelFilter === 'all') return true;
        return w.level === levelFilter;
    });

    // Group by type
    const grouped = filtered.reduce((acc, w) => {
        const key = w.warning_type;
        if (!acc[key]) acc[key] = [];
        acc[key].push(w);
        return acc;
    }, {} as Record<string, PnLWarningItem[]>);

    return (
        <SlidePanel
            isOpen={true}
            onClose={onClose}
            title="⚠️ Warnings & Validation"
            width="600px"
        >
            {/* Summary */}
            <Flex gap={2} mb={4}>
                <Button
                    size="sm"
                    variant={levelFilter === 'all' ? 'solid' : 'outline'}
                    onClick={() => setLevelFilter('all')}
                >
                    All ({warnings.length})
                </Button>
                {errorCount > 0 && (
                    <Button
                        size="sm"
                        colorPalette="red"
                        variant={levelFilter === 'error' ? 'solid' : 'outline'}
                        onClick={() => setLevelFilter('error')}
                    >
                        <FiAlertCircle /> Errors ({errorCount})
                    </Button>
                )}
                {warningCount > 0 && (
                    <Button
                        size="sm"
                        colorPalette="orange"
                        variant={levelFilter === 'warning' ? 'solid' : 'outline'}
                        onClick={() => setLevelFilter('warning')}
                    >
                        <FiAlertTriangle /> Warnings ({warningCount})
                    </Button>
                )}
                {infoCount > 0 && (
                    <Button
                        size="sm"
                        colorPalette="blue"
                        variant={levelFilter === 'info' ? 'solid' : 'outline'}
                        onClick={() => setLevelFilter('info')}
                    >
                        <FiInfo /> Info ({infoCount})
                    </Button>
                )}
            </Flex>

            {/* Warnings grouped by type */}
            {Object.entries(grouped).length === 0 ? (
                <Card.Root>
                    <Card.Body>
                        <Flex direction="column" align="center" py={8}>
                            <Text fontSize="4xl" mb={2}>✅</Text>
                            <Text fontWeight="bold" color="green.600">All Clear!</Text>
                            <Text color="gray.500">No warnings to display</Text>
                        </Flex>
                    </Card.Body>
                </Card.Root>
            ) : (
                Object.entries(grouped).map(([type, items]) => {
                    const typeConfig = getWarningTypeConfig(type);
                    return (
                        <Card.Root key={type} mb={4}>
                            <Card.Header py={2}>
                                <Flex align="center" gap={2}>
                                    <Badge colorPalette={typeConfig.colorPalette}>
                                        {typeConfig.icon} {type}
                                    </Badge>
                                    <Text fontSize="sm" color="gray.500">
                                        ({items.length} {items.length === 1 ? 'issue' : 'issues'})
                                    </Text>
                                </Text>
                            </Flex>
                        </Card.Header>
                        <Card.Body py={2}>
                            {items.map((warning) => {
                                const colors = getWarningColor(warning.level);
                                return (
                                    <Box
                                        key={warning.id}
                                        p={3}
                                        mb={2}
                                        bg={colors.bg}
                                        borderWidth="1px"
                                        borderColor={colors.border}
                                        borderRadius="md"
                                    >
                                        <Flex gap={3}>
                                            <Box mt={1}>
                                                {getWarningIcon(warning.level)}
                                            </Box>
                                            <Box flex="1">
                                                <Text fontSize="sm" mb={1}>
                                                    {warning.message}
                                                </Text>
                                                <Flex gap={2} wrap="wrap">
                                                    {warning.transaction_id && onTransactionClick && (
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() => onTransactionClick(warning.transaction_id!)}
                                                        >
                                                            TX #{warning.transaction_id}
                                                            <FiExternalLink size={12} />
                                                        </Button>
                                                    )}
                                                    {warning.unit_id && onUnitClick && (
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() => onUnitClick(warning.unit_id!)}
                                                        >
                                                            Unit #{warning.unit_id}
                                                            <FiExternalLink size={12} />
                                                        </Button>
                                                    )}
                                                    {warning.action_label && warning.action_link && (
                                                        <Button size="xs" colorPalette="blue">
                                                            {warning.action_label}
                                                        </Button>
                                                    )}
                                                    {/* Add Price button for price-related warnings */}
                                                    {isPriceWarning(warning) && quoteAssetId && baseCurrency && (
                                                        <Button
                                                            size="xs"
                                                            colorPalette="green"
                                                            onClick={() => handleAddPriceClick(warning)}
                                                        >
                                                            <FiPlus size={12} />
                                                            <Text ml={1}>Add Price</Text>
                                                        </Button>
                                                    )}
                                                </Flex>
                                            </Box>
                                        </Flex>
                                    </Box>
                                );
                            })}
                        </Card.Body>
                    </Card.Root>
                );
                })
            )}

            {/* Manual Price Dialog */}
            {selectedWarning && selectedWarning.asset_id && quoteAssetId && baseCurrency && (
                <AddManualPriceDialog
                    isOpen={dialogOpen}
                    onClose={() => {
                        setDialogOpen(false);
                        setSelectedWarning(null);
                    }}
                    onSave={handlePriceSaved}
                    assetId={selectedWarning.asset_id}
                    assetName={getAssetName(selectedWarning.asset_id)}
                    defaultDate={getDefaultDateFromWarning(selectedWarning)}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={baseCurrency}
                />
            )}
        </SlidePanel>
    );
};

export default WarningsPanel;
