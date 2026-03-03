"use client"

import {
    Badge,
    Box,
    Button,
    Dialog,
    Flex,
    HStack,
    Portal,
    RadioGroup,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { API_URL } from '../types';
import { toaster } from './ui/toaster';

interface CleanupPreview {
    connector_ids: number[];
    connector_names: string[];
    transactions: number;
    raw_transactions: number;
    cost_lots: number;
    sync_runs: number;
    file_imports: number;
    transfer_references: number;
    derivative_positions: number;
    pnl_legs_affected: number;
}

interface CleanupDialogProps {
    isOpen: boolean;
    onClose: () => void;
    connectorIds: number[];
    /** 'purge' = keep connector config, 'delete' = remove everything */
    defaultMode?: 'purge' | 'delete';
    title: string;
    onCompleted: () => void;
    /** If set, use account-level cleanup endpoints instead of connector-level */
    accountId?: number;
}

const IMPACT_LABELS: { key: keyof CleanupPreview; label: string; icon: string; isWarning?: boolean }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'raw_transactions', label: 'Raw transactions', icon: '📋' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'sync_runs', label: 'Sync runs', icon: '🔄' },
    { key: 'file_imports', label: 'File imports', icon: '📁' },
    { key: 'derivative_positions', label: 'Derivative positions', icon: '📊' },
    { key: 'transfer_references', label: 'Transfer references (cleared, not deleted)', icon: '↔️', isWarning: true },
];

export const CleanupDialog: React.FC<CleanupDialogProps> = ({
    isOpen,
    onClose,
    connectorIds,
    defaultMode = 'purge',
    title,
    onCompleted,
    accountId,
}) => {
    const [preview, setPreview] = useState<CleanupPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'purge' | 'delete'>(defaultMode);

    useEffect(() => {
        setMode(defaultMode);
    }, [defaultMode]);

    useEffect(() => {
        if (!isOpen || (connectorIds.length === 0 && !accountId)) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                let res: Response;
                if (accountId) {
                    res = await fetch(`${API_URL}/accounts/${accountId}/cleanup-preview`, {
                        method: 'POST',
                    });
                } else {
                    res = await fetch(`${API_URL}/connectors/cleanup-preview`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            connector_ids: connectorIds,
                            delete_connectors: false,
                        }),
                    });
                }
                if (!res.ok) throw new Error('Failed to load cleanup preview');
                const data: CleanupPreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, connectorIds, accountId]);

    const handleConfirm = async () => {
        setExecuting(true);
        try {
            let res: Response;
            if (accountId) {
                res = await fetch(`${API_URL}/accounts/${accountId}/cleanup`, {
                    method: 'POST',
                });
            } else {
                res = await fetch(`${API_URL}/connectors/cleanup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        connector_ids: connectorIds,
                        delete_connectors: mode === 'delete',
                    }),
                });
            }
            if (!res.ok) throw new Error('Cleanup operation failed');

            toaster.success({
                title: 'Cleanup Complete',
                description: mode === 'delete'
                    ? 'Connectors and all data have been deleted.'
                    : 'Data has been purged. Connector configs preserved.',
            });
            onCompleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Cleanup failed');
        } finally {
            setExecuting(false);
        }
    };

    const totalAffected = preview
        ? preview.transactions + preview.raw_transactions + preview.cost_lots +
        preview.sync_runs + preview.file_imports + preview.derivative_positions
        : 0;

    const hasAnyImpact = totalAffected > 0 || (preview?.transfer_references ?? 0) > 0;

    const confirmLabel = mode === 'delete' ? 'Delete Connector & Data' : 'Purge Data';

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="520px">
                        <Dialog.Header>
                            <Dialog.Title>{title}</Dialog.Title>
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
                                    {/* Connector names */}
                                    {preview.connector_names.length > 0 && (
                                        <Box>
                                            <Text fontSize="xs" color="gray.500" mb={1}>Affected connectors:</Text>
                                            <Flex gap={1} flexWrap="wrap">
                                                {preview.connector_names.map((name, idx) => (
                                                    <Badge key={idx} size="sm" variant="subtle" colorPalette="blue">
                                                        {name}
                                                    </Badge>
                                                ))}
                                            </Flex>
                                        </Box>
                                    )}

                                    {/* Impact summary */}
                                    {hasAnyImpact ? (
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
                                                {IMPACT_LABELS.map(({ key, label, icon, isWarning }) => {
                                                    const count = preview[key] as number;
                                                    if (count === 0) return null;
                                                    return (
                                                        <HStack key={key} justify="space-between" fontSize="sm">
                                                            <Text color="gray.700">{icon} {label}</Text>
                                                            <Badge
                                                                colorPalette={isWarning ? 'yellow' : 'red'}
                                                                variant="subtle"
                                                                size="sm"
                                                            >
                                                                {count}
                                                            </Badge>
                                                        </HStack>
                                                    );
                                                })}
                                            </VStack>

                                            {/* P&L warning */}
                                            {preview.pnl_legs_affected > 0 && (
                                                <Box
                                                    mt={2}
                                                    p={2}
                                                    bg="orange.50"
                                                    borderRadius="sm"
                                                    borderWidth="1px"
                                                    borderColor="orange.200"
                                                >
                                                    <Text fontSize="xs" color="orange.700">
                                                        ⚠️ {preview.pnl_legs_affected} P&L calculation legs reference these transactions. You will need to recalculate P&L after cleanup.
                                                    </Text>
                                                </Box>
                                            )}
                                        </Box>
                                    ) : (
                                        <Text fontSize="sm" color="gray.600">
                                            No data found for these connectors.
                                        </Text>
                                    )}

                                    {/* Mode selection (only for connector-level, not account-level) */}
                                    {!accountId && (
                                        <Box>
                                            <Text fontSize="xs" color="gray.500" mb={2}>Cleanup mode:</Text>
                                            <RadioGroup.Root
                                                value={mode}
                                                onValueChange={(e) => setMode(e.value as 'purge' | 'delete')}
                                            >
                                                <VStack align="stretch" gap={2}>
                                                    <RadioGroup.Item value="purge">
                                                        <RadioGroup.ItemHiddenInput />
                                                        <RadioGroup.ItemIndicator />
                                                        <RadioGroup.ItemText fontSize="sm">
                                                            Purge data only (keep connector configuration)
                                                        </RadioGroup.ItemText>
                                                    </RadioGroup.Item>
                                                    <RadioGroup.Item value="delete">
                                                        <RadioGroup.ItemHiddenInput />
                                                        <RadioGroup.ItemIndicator />
                                                        <RadioGroup.ItemText fontSize="sm">
                                                            Delete connectors entirely
                                                        </RadioGroup.ItemText>
                                                    </RadioGroup.Item>
                                                </VStack>
                                            </RadioGroup.Root>
                                        </Box>
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
                                    disabled={executing}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="red"
                                    onClick={handleConfirm}
                                    loading={executing}
                                    disabled={loading || !!error}
                                >
                                    {confirmLabel}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default CleanupDialog;
