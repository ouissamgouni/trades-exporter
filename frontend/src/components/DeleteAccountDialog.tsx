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

interface DeletePreview {
    account_id: number;
    account_name: string;
    transactions: number;
    connectors: number;
    cost_lots: number;
    derivative_positions: number;
    raw_accounts: number;
    transfer_references: number;
    sync_runs: number;
    file_imports: number;
}

interface DeleteAccountDialogProps {
    isOpen: boolean;
    onClose: () => void;
    accountId: number | null;
    accountName: string;
    onDeleted: () => void;
}

const DEPENDENCY_LABELS: { key: keyof DeletePreview; label: string; icon: string }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'connectors', label: 'Connectors', icon: '🔌' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'derivative_positions', label: 'Derivative positions', icon: '📊' },
    { key: 'raw_accounts', label: 'Raw account mappings', icon: '🔗' },
    { key: 'sync_runs', label: 'Sync runs', icon: '🔄' },
    { key: 'file_imports', label: 'File imports', icon: '📁' },
    { key: 'transfer_references', label: 'Transfer references (cleared, not deleted)', icon: '↔️' },
];

export const DeleteAccountDialog: React.FC<DeleteAccountDialogProps> = ({
    isOpen,
    onClose,
    accountId,
    accountName,
    onDeleted,
}) => {
    const [preview, setPreview] = useState<DeletePreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || accountId == null) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`${API_URL}/accounts/${accountId}/delete-preview`);
                if (!res.ok) throw new Error('Failed to load deletion preview');
                const data: DeletePreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, accountId]);

    const handleDelete = async () => {
        if (accountId == null) return;
        setDeleting(true);
        try {
            const res = await fetch(`${API_URL}/accounts/${accountId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete account');
            onDeleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Deletion failed');
        } finally {
            setDeleting(false);
        }
    };

    const totalAffected = preview
        ? preview.transactions + preview.connectors + preview.cost_lots +
        preview.derivative_positions + preview.raw_accounts +
        preview.sync_runs + preview.file_imports
        : 0;

    const hasAnyDependencies = totalAffected > 0 || (preview?.transfer_references ?? 0) > 0;

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="480px">
                        <Dialog.Header>
                            <Dialog.Title>Delete Account</Dialog.Title>
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
                                        <Text as="span" fontWeight="bold">{accountName}</Text>?
                                    </Text>

                                    {hasAnyDependencies ? (
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
                                                {DEPENDENCY_LABELS.map(({ key, label, icon }) => {
                                                    const count = preview[key] as number;
                                                    if (count === 0) return null;
                                                    return (
                                                        <HStack key={key} justify="space-between" fontSize="sm">
                                                            <Text color="gray.700">{icon} {label}</Text>
                                                            <Badge
                                                                colorPalette={key === 'transfer_references' ? 'yellow' : 'red'}
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
                                    ) : (
                                        <Text fontSize="sm" color="gray.600">
                                            This account has no dependent data.
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
                                    Delete
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default DeleteAccountDialog;
