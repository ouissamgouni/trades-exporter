/**
 * Warnings Panel
 * 
 * Shows all warnings with severity levels and actions.
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React, { useState } from 'react';
import { FiExternalLink, FiAlertTriangle, FiAlertCircle, FiInfo, FiPlus } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { PnLWarningItem, WarningLevel } from './types';
import { PriceSetterDialog } from './PriceSetterDialog';
import { getWarningTypeConfig } from './warningStyles';
import { Badge, type BadgeColorScheme, Button } from '../ui/primitives';

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
            return { bg: 'bg-red-50', border: 'border-red-200' };
        case 'warning':
            return { bg: 'bg-orange-50', border: 'border-orange-200' };
        case 'info':
        default:
            return { bg: 'bg-blue-50', border: 'border-blue-200' };
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
            <div className="mb-4 flex gap-2">
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
                        colorScheme="red"
                        variant={levelFilter === 'error' ? 'solid' : 'outline'}
                        onClick={() => setLevelFilter('error')}
                    >
                        <FiAlertCircle /> Errors ({errorCount})
                    </Button>
                )}
                {warningCount > 0 && (
                    <Button
                        size="sm"
                        variant={levelFilter === 'warning' ? 'solid' : 'outline'}
                        className={levelFilter === 'warning' ? 'border-orange-600 bg-orange-600 hover:bg-orange-700' : 'border-orange-300 text-orange-700 hover:bg-orange-50'}
                        onClick={() => setLevelFilter('warning')}
                    >
                        <FiAlertTriangle /> Warnings ({warningCount})
                    </Button>
                )}
                {infoCount > 0 && (
                    <Button
                        size="sm"
                        colorScheme="blue"
                        variant={levelFilter === 'info' ? 'solid' : 'outline'}
                        onClick={() => setLevelFilter('info')}
                    >
                        <FiInfo /> Info ({infoCount})
                    </Button>
                )}
            </div>

            {/* Warnings grouped by type */}
            {Object.entries(grouped).length === 0 ? (
                <div className="border border-slate-200 bg-white">
                    <div className="px-4 py-2">
                        <div className="flex flex-col items-center py-8">
                            <span className="mb-2 block text-4xl">✅</span>
                            <span className="block font-bold text-green-600">All Clear!</span>
                            <span className="block text-slate-500">No warnings to display</span>
                        </div>
                    </div>
                </div>
            ) : (
                Object.entries(grouped).map(([type, items]) => {
                    const typeConfig = getWarningTypeConfig(type);
                    return (
                        <div key={type} className="mb-4 border border-slate-200 bg-white">
                            <div className="border-b border-slate-100 px-4 py-2">
                                <div className="flex items-center gap-2">
                                    <Badge colorScheme={typeConfig.colorPalette as BadgeColorScheme}>
                                        {typeConfig.icon} {type}
                                    </Badge>
                                    <span className="text-sm text-slate-500">
                                        ({items.length} {items.length === 1 ? 'issue' : 'issues'})
                                    </span>
                                </div>
                            </div>
                            <div className="px-4 py-2">
                                {items.map((warning) => {
                                    const colors = getWarningColor(warning.level);
                                    return (
                                        <div
                                            key={warning.id}
                                            className={`mb-2 border p-3 ${colors.bg} ${colors.border}`}
                                        >
                                            <div className="flex gap-3">
                                                <div className="mt-1">
                                                    {getWarningIcon(warning.level)}
                                                </div>
                                                <div className="flex-1">
                                                    <p className="mb-1 text-sm">
                                                        {warning.message}
                                                    </p>
                                                    <div className="flex flex-wrap gap-2">
                                                        {warning.transaction_id && onTransactionClick && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={() => onTransactionClick(warning.transaction_id!)}
                                                            >
                                                                TX #{warning.transaction_id}
                                                                <FiExternalLink size={12} />
                                                            </Button>
                                                        )}
                                                        {warning.unit_id && onUnitClick && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={() => onUnitClick(warning.unit_id!)}
                                                            >
                                                                Unit #{warning.unit_id}
                                                                <FiExternalLink size={12} />
                                                            </Button>
                                                        )}
                                                        {warning.action_label && warning.action_link && (
                                                            <Button size="sm" colorScheme="blue">
                                                                {warning.action_label}
                                                            </Button>
                                                        )}
                                                        {/* Add Price button for price-related warnings */}
                                                        {isPriceWarning(warning) && quoteAssetId && baseCurrency && (
                                                            <Button
                                                                size="sm"
                                                                colorScheme="green"
                                                                onClick={() => handleAddPriceClick(warning)}
                                                            >
                                                                <FiPlus size={12} />
                                                                <span className="ml-1">Add Price</span>
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })
            )}

            {/* Manual Price Dialog */}
            {
                selectedWarning && selectedWarning.asset_id && quoteAssetId && baseCurrency && (
                    <PriceSetterDialog
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
                )
            }
        </SlidePanel >
    );
};

export default WarningsPanel;
