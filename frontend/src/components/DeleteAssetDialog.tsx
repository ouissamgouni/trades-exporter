"use client"

import {
    Badge,
    Box,
    Button,
    Dialog,
    Flex,
    HStack,
    Portal,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { API_URL } from '../types';

interface AssetDeletePreview {
    asset_id: number;
    asset_symbol: string;
    // Cascade (light, auto-deleted)
    asset_categories: number;
    price_getters: number;
    raw_assets: number;
    price_snapshots: number;
    // Heavy data (require force)
    transactions: number;
    cost_lots: number;
    realized_pnl: number;
    calculation_unit_legs: number;
    fee_entries: number;
    pnl_warnings: number;
}

interface DeleteAssetDialogProps {
    isOpen: boolean;
    onClose: () => void;
    assetId: number | null;
    assetSymbol: string;
    onDeleted: () => void;
}

const CASCADE_LABELS: { key: keyof AssetDeletePreview; label: string; icon: string }[] = [
    { key: 'asset_categories', label: 'Category assignments', icon: '🏷️' },
    { key: 'price_getters', label: 'Price getters', icon: '💰' },
    { key: 'raw_assets', label: 'Raw asset mappings', icon: '🔗' },
    { key: 'price_snapshots', label: 'Price snapshots', icon: '📈' },
];

const BLOCKER_LABELS: { key: keyof AssetDeletePreview; label: string; icon: string }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'realized_pnl', label: 'Realized P&L entries', icon: '💵' },
    { key: 'calculation_unit_legs', label: 'Calculation unit legs', icon: '📊' },
    { key: 'fee_entries', label: 'Fee entries', icon: '🧾' },
    { key: 'pnl_warnings', label: 'P&L warnings', icon: '⚠️' },
];

export const DeleteAssetDialog: React.FC<DeleteAssetDialogProps> = ({
    isOpen,
    onClose,
    assetId,
    assetSymbol,
    onDeleted,
}) => {
    const [preview, setPreview] = useState<AssetDeletePreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || assetId == null) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`${API_URL}/assets/${assetId}/delete-preview`);
                if (!res.ok) throw new Error('Failed to load deletion preview');
                const data: AssetDeletePreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, assetId]);

    const hasBlockers = preview
        ? (preview.transactions + preview.cost_lots + preview.realized_pnl +
            preview.calculation_unit_legs + preview.fee_entries + preview.pnl_warnings) > 0
        : false;

    const hasCascade = preview
        ? (preview.asset_categories + preview.price_getters + preview.raw_assets + preview.price_snapshots) > 0
        : false;

    const hasAnyDependencies = hasBlockers || hasCascade;

    const handleDelete = async () => {
        if (assetId == null) return;
        setDeleting(true);
        try {
            const forceParam = hasBlockers ? '?force=true' : '';
            const res = await fetch(`${API_URL}/assets/${assetId}${forceParam}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete asset');
            onDeleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Deletion failed');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="480px">
                        <Dialog.Header>
                            <Dialog.Title>Delete Asset</Dialog.Title>
                        </Dialog.Header>

                        <Dialog.Body>
                            {loading ? (
                                <Flex justify="center" py={6}>
                                    <Spinner size="lg" />
                                </Flex>
                            ) : error ? (
                                <Text color="red.500">{error}</Text>
                            ) : preview ? (
                                <VStack align="stretch" gap={3}>
                                    <Text>
                                        Are you sure you want to delete{' '}
                                        <Text as="span" fontWeight="bold">{assetSymbol}</Text>?
                                    </Text>

                                    {hasBlockers && (
                                        <Box
                                            borderWidth="1px"
                                            borderColor="red.200"
                                            bg="red.50"
                                            borderRadius="md"
                                            p={3}
                                        >
                                            <HStack gap={2} mb={2}>
                                                <FiAlertTriangle color="var(--chakra-colors-red-500)" />
                                                <Text fontWeight="semibold" fontSize="sm" color="red.700">
                                                    The following data will be permanently deleted:
                                                </Text>
                                            </HStack>
                                            <VStack align="stretch" gap={1} pl={1}>
                                                {BLOCKER_LABELS.map(({ key, label, icon }) => {
                                                    const count = preview[key] as number;
                                                    if (count === 0) return null;
                                                    return (
                                                        <HStack key={key} justify="space-between" fontSize="sm">
                                                            <Text color="gray.700">{icon} {label}</Text>
                                                            <Badge
                                                                colorPalette="red"
                                                                variant="subtle"
                                                                size="sm"
                                                            >
                                                                {count}
                                                            </Badge>
                                                        </HStack>
                                                    );
                                                })}
                                            </VStack>
                                        </Box>
                                    )}

                                    {hasCascade && (
                                        <Box
                                            borderWidth="1px"
                                            borderColor="orange.200"
                                            bg="orange.50"
                                            borderRadius="md"
                                            p={3}
                                        >
                                            <Text fontWeight="semibold" fontSize="sm" color="orange.700" mb={2}>
                                                Also removed (auto-cascade):
                                            </Text>
                                            <VStack align="stretch" gap={1} pl={1}>
                                                {CASCADE_LABELS.map(({ key, label, icon }) => {
                                                    const count = preview[key] as number;
                                                    if (count === 0) return null;
                                                    return (
                                                        <HStack key={key} justify="space-between" fontSize="sm">
                                                            <Text color="gray.700">{icon} {label}</Text>
                                                            <Badge
                                                                colorPalette="orange"
                                                                variant="subtle"
                                                                size="sm"
                                                            >
                                                                {count}
                                                            </Badge>
                                                        </HStack>
                                                    );
                                                })}
                                            </VStack>
                                        </Box>
                                    )}

                                    {!hasAnyDependencies && (
                                        <Text fontSize="sm" color="gray.600">
                                            This asset has no dependent data.
                                        </Text>
                                    )}

                                    <Text fontSize="xs" color="gray.500">
                                        This action cannot be undone.
                                    </Text>
                                </VStack>
                            ) : null}
                        </Dialog.Body>

                        <Dialog.Footer>
                            <Flex gap={3}>
                                <Button
                                    variant="outline"
                                    onClick={onClose}
                                    disabled={deleting}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="red"
                                    onClick={handleDelete}
                                    loading={deleting}
                                    disabled={loading || !!error}
                                >
                                    {hasBlockers ? 'Force Delete' : 'Delete'}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default DeleteAssetDialog;
