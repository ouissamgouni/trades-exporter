/**
 * BundleCreateDialog
 *
 * A modal dialog for creating a new bundle with full control over parameters:
 * pattern, label, notes, and taxability override.
 *
 * Opened from the TransactionsTable bulk action toolbar (Swap / Transfer / Bundle buttons).
 * The caller pre-fills defaultPattern and defaultLabel; the user can adjust before submitting.
 */

import React, { useEffect, useState } from 'react';
import {
    Box, Button, Dialog, Flex, Input, NativeSelect,
    Portal, Text, Textarea,
} from '@chakra-ui/react';
import { TaxabilityStatus, UnitPattern } from '../../enums';
import { API_URL } from '../../types';
import { toaster } from '../ui/toaster';

// Human-readable labels for each pattern
const PATTERN_LABELS: Record<string, string> = {
    [UnitPattern.SWAP]: '🔄 Swap — Exchange of assets',
    [UnitPattern.INTERNAL_TRANSFER]: '↔ Internal Transfer — Between owned accounts',
    [UnitPattern.FLOW]: '➡ Flow — External single-leg movement',
    [UnitPattern.SPLIT]: '📊 Split — Stock/token split',
    [UnitPattern.CUSTOM]: '📦 Custom — User-defined grouping',
    [UnitPattern.UNKNOWN]: '❓ Unknown — Needs review',
};

// Ordered list of user-selectable patterns (exclude unmatched_internal_transfer — system-only)
const SELECTABLE_PATTERNS = [
    UnitPattern.SWAP,
    UnitPattern.INTERNAL_TRANSFER,
    UnitPattern.FLOW,
    UnitPattern.SPLIT,
    UnitPattern.CUSTOM,
    UnitPattern.UNKNOWN,
];

const TAXABILITY_BG: Record<string, string> = {
    [TaxabilityStatus.TAXABLE]: '#FED7AA',
    [TaxabilityStatus.NON_TAXABLE]: '#C6F6D5',
    [TaxabilityStatus.UNKNOWN]: '#FEFCBF',
};

export interface BundleCreateDefaults {
    /** Pre-selected pattern (from which button was clicked) */
    pattern: string;
    /** Pre-generated label */
    label: string;
    /** Transaction IDs to include */
    transactionIds: number[];
}

interface BundleCreateDialogProps {
    isOpen: boolean;
    onClose: () => void;
    /** Called after a bundle is successfully created */
    onCreated: () => void;
    /** Defaults to pre-fill the form */
    defaults: BundleCreateDefaults;
    /** Function to regenerate label based on pattern (from TransactionsTable) */
    generateLabel: (pattern: string) => string;
}

export const BundleCreateDialog: React.FC<BundleCreateDialogProps> = ({
    isOpen,
    onClose,
    onCreated,
    defaults,
    generateLabel,
}) => {
    const [pattern, setPattern] = useState(defaults.pattern);
    const [label, setLabel] = useState(defaults.label);
    const [notes, setNotes] = useState('');
    const [taxability, setTaxability] = useState<string>(TaxabilityStatus.UNKNOWN);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Reset form when dialog opens with new defaults
    useEffect(() => {
        if (isOpen) {
            setPattern(defaults.pattern);
            setLabel(defaults.label);
            setNotes('');
            setTaxability(TaxabilityStatus.UNKNOWN);
            setError('');
        }
    }, [isOpen, defaults]);

    // Re-generate label when pattern changes (unless user has manually edited it)
    const [labelManuallyEdited, setLabelManuallyEdited] = useState(false);

    useEffect(() => {
        if (isOpen) setLabelManuallyEdited(false);
    }, [isOpen]);

    const handlePatternChange = (newPattern: string) => {
        setPattern(newPattern);
        if (!labelManuallyEdited) {
            setLabel(generateLabel(newPattern));
        }
    };

    const handleLabelChange = (value: string) => {
        setLabel(value);
        setLabelManuallyEdited(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const payload: Record<string, any> = {
                transaction_ids: defaults.transactionIds,
                label: label || null,
                pattern,
            };
            if (notes.trim()) payload.notes = notes.trim();
            if (taxability !== TaxabilityStatus.UNKNOWN) {
                payload.taxability_override = taxability;
            }

            const response = await fetch(`${API_URL}/bundles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to create bundle');
            }

            toaster.success({
                title: 'Bundle created',
                description: `"${label || 'Bundle'}" with ${defaults.transactionIds.length} transaction(s)`,
            });
            onCreated();
            onClose();
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create bundle';
            setError(msg);
            toaster.error({ title: 'Error', description: msg });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="480px">
                        <Dialog.Header>
                            <Dialog.Title>Create Bundle</Dialog.Title>
                        </Dialog.Header>
                        <form onSubmit={handleSubmit}>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    {error && (
                                        <Box bg="red.50" p={2} borderRadius="md" borderWidth={1} borderColor="red.200">
                                            <Text color="red.600" fontSize="sm">{error}</Text>
                                        </Box>
                                    )}

                                    {/* Info */}
                                    <Box bg="gray.50" p={2} borderRadius="md">
                                        <Text fontSize="xs" color="gray.600">
                                            Bundling {defaults.transactionIds.length} transaction{defaults.transactionIds.length !== 1 ? 's' : ''}
                                        </Text>
                                    </Box>

                                    {/* Pattern */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1} fontSize="sm">Pattern</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={pattern}
                                                onChange={(e) => handlePatternChange(e.target.value)}
                                            >
                                                {SELECTABLE_PATTERNS.map(p => (
                                                    <option key={p} value={p}>
                                                        {PATTERN_LABELS[p] || p}
                                                    </option>
                                                ))}
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>

                                    {/* Label */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1} fontSize="sm">Label</Text>
                                        <Input
                                            value={label}
                                            onChange={(e) => handleLabelChange(e.target.value)}
                                            placeholder="e.g., BTC → ETH Swap"
                                            size="sm"
                                        />
                                    </Box>

                                    {/* Notes */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1} fontSize="sm">
                                            Notes <Text as="span" color="gray.400" fontWeight="normal">(optional)</Text>
                                        </Text>
                                        <Textarea
                                            value={notes}
                                            onChange={(e) => setNotes(e.target.value)}
                                            placeholder="Additional context or reason for this bundle..."
                                            size="sm"
                                            rows={2}
                                        />
                                    </Box>

                                    {/* Taxability */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1} fontSize="sm">Taxability Override</Text>
                                        <NativeSelect.Root size="sm" width="160px">
                                            <NativeSelect.Field
                                                value={taxability}
                                                onChange={(e) => setTaxability(e.target.value)}
                                                style={{
                                                    fontSize: '12px',
                                                    padding: '4px 8px',
                                                    backgroundColor: TAXABILITY_BG[taxability] || '#FEFCBF',
                                                    borderRadius: '4px',
                                                }}
                                            >
                                                <option value={TaxabilityStatus.UNKNOWN}>Unknown (auto-detect)</option>
                                                <option value={TaxabilityStatus.TAXABLE}>Taxable</option>
                                                <option value={TaxabilityStatus.NON_TAXABLE}>Non-Taxable</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={3}>
                                    <Button variant="outline" onClick={onClose} disabled={loading}>
                                        Cancel
                                    </Button>
                                    <Button type="submit" colorPalette="purple" loading={loading}>
                                        Create Bundle
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
