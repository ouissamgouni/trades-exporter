/**
 * AssetFormDialog - Standalone dialog for creating a new asset.
 *
 * Mirrors the inline create dialog inside AssetSelector but can be opened
 * independently (e.g. from a quick-create "+" button next to unlinked assets).
 *
 * On successful creation the dialog calls `onClose(createdAssetId)`.
 */

import React, { useState } from 'react';
import {
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    NativeSelect,
    Portal,
    Text,
} from '@chakra-ui/react';
import { API_URL } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { toaster } from './ui/toaster';

export interface AssetPrefill {
    symbol?: string;
    label?: string;
    price_type?: string;
}

interface AssetFormDialogProps {
    isOpen: boolean;
    onClose: (createdAssetId?: number) => void;
    prefill?: AssetPrefill;
    /** If provided, link the raw_asset to the newly created asset. */
    rawAssetSource?: string;
    rawAssetSymbol?: string;
}

const AssetFormDialog: React.FC<AssetFormDialogProps> = ({
    isOpen,
    onClose,
    prefill,
    rawAssetSource,
    rawAssetSymbol,
}) => {
    const [formData, setFormData] = useState({
        symbol: prefill?.symbol || '',
        label: prefill?.label || '',
        price_type: prefill?.price_type || '',
        tags: [] as Record<string, any>[],
        status: 0,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Reset form when dialog opens with new prefill
    React.useEffect(() => {
        if (isOpen) {
            setFormData({
                symbol: prefill?.symbol?.toUpperCase() || '',
                label: prefill?.label || prefill?.symbol || '',
                price_type: prefill?.price_type || '',
                tags: [],
                status: 0,
            });
            setError('');
        }
    }, [isOpen, prefill?.symbol, prefill?.label, prefill?.price_type]);

    const linkRawAsset = async (assetId: number) => {
        if (!rawAssetSource || !rawAssetSymbol || !assetId) return;
        try {
            const patchResponse = await fetch(
                `${API_URL}/raw-assets/${encodeURIComponent(rawAssetSource)}/${encodeURIComponent(rawAssetSymbol)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId }),
                }
            );
            if (patchResponse.status === 404) {
                await fetch(`${API_URL}/raw-assets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: rawAssetSymbol,
                        source: rawAssetSource,
                        asset_id: assetId,
                    }),
                });
            }
        } catch (err) {
            console.warn('Failed to link raw asset:', err);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.symbol.trim()) {
            setError('Symbol is required');
            return;
        }

        setLoading(true);
        setError('');
        try {
            const response = await fetch(`${API_URL}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: formData.symbol.toUpperCase(),
                    label: formData.label || null,
                    price_type: formData.price_type || null,
                    tags: formData.tags.length > 0 ? formData.tags : null,
                    status: formData.status,
                }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create asset');
            }

            const created = await response.json();

            // Link raw_asset if context provided
            if (created.asset_id) {
                await linkRawAsset(created.asset_id);
            }

            toaster.success({ title: `Asset "${formData.symbol}" created` });
            onClose(created.asset_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create asset');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog.Root
            open={isOpen}
            onOpenChange={(e) => {
                if (!e.open) onClose();
            }}
        >
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <form onSubmit={handleSubmit}>
                            <Dialog.Header>
                                <Dialog.Title>Create New Asset</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    {error && (
                                        <Text color="red.500" fontSize="sm">
                                            {error}
                                        </Text>
                                    )}
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Symbol *
                                        </Text>
                                        <Input
                                            placeholder="e.g., BTC, ETH, USDT"
                                            value={formData.symbol}
                                            onChange={(e) =>
                                                setFormData({ ...formData, symbol: e.target.value.toUpperCase() })
                                            }
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Label
                                        </Text>
                                        <Input
                                            placeholder="e.g., Bitcoin, Ethereum"
                                            value={formData.label}
                                            onChange={(e) =>
                                                setFormData({ ...formData, label: e.target.value })
                                            }
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Type
                                        </Text>
                                        <ComboSelect
                                            value={formData.price_type}
                                            onChange={(val) =>
                                                setFormData({ ...formData, price_type: val })
                                            }
                                            options={ASSET_TYPE_OPTIONS}
                                            placeholder="Select or type..."
                                            width="100%"
                                            size="md"
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Tags
                                        </Text>
                                        <Input
                                            placeholder="e.g., defi, layer1, stablecoin (comma-separated)"
                                            value={formData.tags
                                                .map((t) => Object.keys(t)[0])
                                                .filter(Boolean)
                                                .join(', ')}
                                            onChange={(e) => {
                                                const tagStrings = e.target.value
                                                    .split(',')
                                                    .map((t) => t.trim())
                                                    .filter((t) => t);
                                                const tags = tagStrings.map((tag) => ({ [tag]: true }));
                                                setFormData({ ...formData, tags });
                                            }}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Status
                                        </Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={String(formData.status)}
                                                onChange={(e) =>
                                                    setFormData({
                                                        ...formData,
                                                        status: parseInt(e.target.value),
                                                    })
                                                }
                                            >
                                                <option value="0">Active</option>
                                                <option value="1">Inactive</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => onClose()}>
                                        Cancel
                                    </Button>
                                    <Button
                                        type="submit"
                                        colorPalette="green"
                                        loading={loading}
                                        disabled={!formData.symbol.trim()}
                                    >
                                        Create
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </form>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default AssetFormDialog;
