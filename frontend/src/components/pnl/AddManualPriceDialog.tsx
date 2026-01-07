/**
 * AddManualPriceDialog
 * 
 * A dialog for adding a manual price snapshot for a specific asset.
 * Used when price fetch fails (errors) or price is stale.
 * 
 * Pre-filled with:
 * - Asset (read-only, from context)
 * - Date (editable, default from context or today)
 * - Quote asset (from base currency)
 * 
 * User provides:
 * - Price value
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

export interface AddManualPriceDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;  // Called after successful save (for refresh)
    assetId: number;
    assetName: string;
    defaultDate: string;  // ISO date string (YYYY-MM-DD or full ISO)
    quoteAssetId: number;  // Base currency asset ID
    quoteAssetName: string;  // Base currency symbol (e.g., "EUR")
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
}) => {
    // Parse the default date to YYYY-MM-DD format for the input
    const getDateInputValue = (isoDate: string) => {
        try {
            const date = new Date(isoDate);
            return date.toISOString().split('T')[0];
        } catch {
            return new Date().toISOString().split('T')[0];
        }
    };

    const [date, setDate] = useState(getDateInputValue(defaultDate));
    const [price, setPrice] = useState<string>('');
    const [isSaving, setIsSaving] = useState(false);

    // Reset state when dialog opens with new asset
    React.useEffect(() => {
        if (isOpen) {
            setDate(getDateInputValue(defaultDate));
            setPrice('');
        }
    }, [isOpen, defaultDate]);

    const handleSave = async () => {
        const priceValue = parseFloat(price);
        if (isNaN(priceValue) || priceValue <= 0) {
            toaster.error({ title: 'Validation error', description: 'Please enter a valid positive price' });
            return;
        }

        setIsSaving(true);
        try {
            // Convert date to full ISO timestamp (start of day UTC)
            const snapshotTime = new Date(date + 'T00:00:00Z').toISOString();

            const response = await fetch(`${API_URL}/price-snapshots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_id: assetId,
                    quote_asset_id: quoteAssetId,
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
                description: `Manual price for ${assetName} saved successfully`
            });
            onSave();
            onClose();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to save price'
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="400px">
                        <Dialog.Header>
                            <Dialog.Title>Add Manual Price</Dialog.Title>
                        </Dialog.Header>
                        <Dialog.Body>
                            <Flex direction="column" gap={4}>
                                {/* Asset (read-only) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                                        Asset
                                    </Text>
                                    <Input
                                        value={assetName}
                                        readOnly
                                        bg="gray.100"
                                        cursor="not-allowed"
                                    />
                                </Box>

                                {/* Quote Asset (read-only) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                                        Quote Currency
                                    </Text>
                                    <Input
                                        value={quoteAssetName}
                                        readOnly
                                        bg="gray.100"
                                        cursor="not-allowed"
                                    />
                                </Box>

                                {/* Date (editable) */}
                                <Box>
                                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                                        Price Date
                                    </Text>
                                    <Input
                                        type="date"
                                        value={date}
                                        onChange={(e) => setDate(e.target.value)}
                                    />
                                    <Text fontSize="xs" color="gray.500" mt={1}>
                                        The date for which this price is valid
                                    </Text>
                                </Box>

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
                                    <Text fontSize="xs" color="gray.500" mt={1}>
                                        The price of 1 {assetName} in {quoteAssetName}
                                    </Text>
                                </Box>
                            </Flex>
                        </Dialog.Body>
                        <Dialog.Footer>
                            <Flex gap={2} justify="flex-end">
                                <Button
                                    variant="outline"
                                    onClick={onClose}
                                    disabled={isSaving}
                                >
                                    <FiX style={{ marginRight: 4 }} />
                                    Cancel
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
