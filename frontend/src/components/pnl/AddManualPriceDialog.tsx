/**
 * AddManualPriceDialog
 * 
 * A dialog for adding a manual price snapshot for a specific asset.
 * Supports two modes:
 *   - Single date: creates one snapshot (existing behavior)
 *   - Date range:  creates a flat-price snapshot for every expected trading day
 *                  in [dateFrom, dateTo] via POST /price-snapshots/bulk-manual
 * 
 * Pre-filled with:
 * - Asset (read-only, from context)
 * - Date(s) (editable, default from context or today)
 * - Quote asset (from base currency)
 * - Default price (last_known_price from gap data, if provided)
 * 
 * User provides:
 * - Price value (pre-filled with defaultPrice when available)
 */

import React, { useState } from 'react';
import {
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    Portal,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiCheck, FiX } from 'react-icons/fi';
import { API_URL } from '../../types';
import { toaster } from '../ui/toaster';
import { useBulkManualPrices } from '../../hooks/usePriceGaps';

type Mode = 'single' | 'range';

export interface AddManualPriceDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;
    assetId: number;
    assetName: string;
    defaultDate: string;
    quoteAssetId?: number;
    quoteAssetName: string;
    /** Optional: pre-select date-range mode with these dates */
    defaultDateFrom?: string;
    defaultDateTo?: string;
    /** Optional: pre-fill the price field (e.g. last known price before a gap) */
    defaultPrice?: number | null;
}

export const AddManualPriceDialog: React.FC<AddManualPriceDialogProps> = ({
    isOpen,
    onClose,
    onSave,
    assetId,
    assetName,
    defaultDate,
    quoteAssetId,
    quoteAssetName,
    defaultDateFrom,
    defaultDateTo,
    defaultPrice,
}) => {
    const getDateInputValue = (isoDate: string) => {
        try {
            return new Date(isoDate).toISOString().split('T')[0];
        } catch {
            return new Date().toISOString().split('T')[0];
        }
    };

    const initialMode: Mode = defaultDateFrom && defaultDateTo ? 'range' : 'single';
    const [mode, setMode] = useState<Mode>(initialMode);
    const [date, setDate] = useState(getDateInputValue(defaultDate));
    const [dateFrom, setDateFrom] = useState(defaultDateFrom ? getDateInputValue(defaultDateFrom) : getDateInputValue(defaultDate));
    const [dateTo, setDateTo] = useState(defaultDateTo ? getDateInputValue(defaultDateTo) : getDateInputValue(defaultDate));
    const [price, setPrice] = useState<string>(defaultPrice != null ? String(defaultPrice) : '');
    const [isSaving, setIsSaving] = useState(false);

    const bulkManual = useBulkManualPrices();

    // Reset when dialog opens
    React.useEffect(() => {
        if (isOpen) {
            const m = defaultDateFrom && defaultDateTo ? 'range' : 'single';
            setMode(m);
            setDate(getDateInputValue(defaultDate));
            setDateFrom(defaultDateFrom ? getDateInputValue(defaultDateFrom) : getDateInputValue(defaultDate));
            setDateTo(defaultDateTo ? getDateInputValue(defaultDateTo) : getDateInputValue(defaultDate));
            setPrice(defaultPrice != null ? String(defaultPrice) : '');
        }
    }, [isOpen, defaultDate, defaultDateFrom, defaultDateTo, defaultPrice]);

    const handleSave = async () => {
        const priceValue = parseFloat(price);
        if (isNaN(priceValue) || priceValue <= 0) {
            toaster.error({ title: 'Validation error', description: 'Please enter a valid positive price' });
            return;
        }

        setIsSaving(true);
        try {
            if (mode === 'range') {
                const result = await bulkManual.mutateAsync({
                    asset_id: assetId,
                    quote_asset_id: quoteAssetId || undefined,
                    date_from: dateFrom,
                    date_to: dateTo,
                    price: priceValue,
                    source: 'manual',
                });
                toaster.success({
                    title: 'Prices added',
                    description: `Created ${result.created_count} snapshot(s) for ${assetName}` +
                        (result.skipped_count ? ` (${result.skipped_count} already existed)` : ''),
                });
            } else {
                const snapshotTime = new Date(date + 'T00:00:00Z').toISOString();
                const response = await fetch(`${API_URL}/price-snapshots`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        asset_id: assetId,
                        quote_asset_id: quoteAssetId || null,
                        snapshot_time: snapshotTime,
                        price: priceValue,
                        source: 'manual',
                    }),
                });

                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.detail || 'Failed to create price');
                }
                toaster.success({
                    title: 'Price added',
                    description: `Manual price for ${assetName} saved successfully`,
                });
            }
            onSave();
            onClose();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to save price',
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
            <Portal>
                <Dialog.Backdrop css={{ zIndex: 2000 }} />
                <Dialog.Positioner css={{ zIndex: 2000 }}>
                    <Dialog.Content maxW="420px">
                        <Dialog.Header>
                            <Dialog.Title>Add Manual Price</Dialog.Title>
                        </Dialog.Header>
                        <Dialog.Body>
                            <Flex direction="column" gap={4}>
                                {/* Asset (read-only) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>Asset</Text>
                                    <Input value={assetName} readOnly bg="gray.100" cursor="not-allowed" />
                                </Box>

                                {/* Quote Asset (read-only) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>Quote Currency</Text>
                                    <Input value={quoteAssetName} readOnly bg="gray.100" cursor="not-allowed" />
                                </Box>

                                {/* Mode toggle */}
                                <Flex gap={2}>
                                    <Button
                                        size="xs"
                                        variant={mode === 'single' ? 'solid' : 'outline'}
                                        colorPalette={mode === 'single' ? 'blue' : 'gray'}
                                        onClick={() => setMode('single')}
                                    >
                                        Single date
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant={mode === 'range' ? 'solid' : 'outline'}
                                        colorPalette={mode === 'range' ? 'blue' : 'gray'}
                                        onClick={() => setMode('range')}
                                    >
                                        Date range
                                    </Button>
                                </Flex>

                                {/* Date fields */}
                                {mode === 'single' ? (
                                    <Box>
                                        <Text fontSize="sm" fontWeight="medium" mb={1}>Price Date</Text>
                                        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                                    </Box>
                                ) : (
                                    <Flex gap={2}>
                                        <Box flex={1}>
                                            <Text fontSize="sm" fontWeight="medium" mb={1}>From</Text>
                                            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                                        </Box>
                                        <Box flex={1}>
                                            <Text fontSize="sm" fontWeight="medium" mb={1}>To</Text>
                                            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                                        </Box>
                                    </Flex>
                                )}

                                {/* Price (user input) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                                        Price in {quoteAssetName}
                                    </Text>
                                    <Input
                                        type="number"
                                        step="any"
                                        min="0"
                                        placeholder="e.g., 42000.50"
                                        value={price}
                                        onChange={(e) => setPrice(e.target.value)}
                                        autoFocus
                                    />
                                    {defaultPrice != null && (
                                        <Text fontSize="xs" color="gray.500" mt={1}>
                                            Pre-filled with last known price before gap
                                        </Text>
                                    )}
                                </Box>

                                {/* Preview for range mode */}
                                {mode === 'range' && price && parseFloat(price) > 0 && (
                                    <Box bg="blue.50" p={2} borderRadius="md">
                                        <Text fontSize="xs" color="blue.700">
                                            Will create snapshots at {quoteAssetName} {parseFloat(price).toLocaleString()} for each trading day from {dateFrom} to {dateTo}
                                        </Text>
                                    </Box>
                                )}
                            </Flex>
                        </Dialog.Body>
                        <Dialog.Footer>
                            <Flex gap={2} justify="flex-end">
                                <Button variant="outline" onClick={onClose} disabled={isSaving}>
                                    <FiX style={{ marginRight: 4 }} /> Cancel
                                </Button>
                                <Button
                                    colorPalette="blue"
                                    onClick={handleSave}
                                    disabled={isSaving || !price}
                                >
                                    {isSaving ? (
                                        <><Spinner size="xs" mr={2} /> Saving...</>
                                    ) : (
                                        <><FiCheck style={{ marginRight: 4 }} /> Save Price</>
                                    )}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default AddManualPriceDialog;
