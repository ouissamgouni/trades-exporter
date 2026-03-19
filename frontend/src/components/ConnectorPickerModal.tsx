/**
 * ConnectorPickerModal
 *
 * A searchable hybrid-tree modal for selecting which accounts and connectors
 * to include in the current sync configuration.
 *
 * Structure:  Account Type → Account Group → Account → Connector
 * Each level has a tri-state checkbox.  A search bar filters the tree live.
 * Accounts and connectors are shown with colored dots from useEntityColors.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Checkbox,
    Dialog,
    Flex,
    Grid,
    Input,
    Portal,
    Text,
    VStack,
} from '@chakra-ui/react';
import { LuSearch } from 'react-icons/lu';
import { EnabledConnector, AccountSummary } from '../types';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';
import { formatAddress, formatChainName } from '../utils/addressUtils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConnectorPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Called with the full set of connector IDs the user wants selected. */
    onConfirm: (selectedConnectorIds: Set<number>) => void;
    allConnectors: EnabledConnector[];
    allAccounts: AccountSummary[];
    /** IDs already in the sync config — pre-checked on open. */
    alreadySelected: Set<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_META: { type: string; label: string; emoji: string; colorScheme: string }[] = [
    { type: 'cex', label: 'Exchanges', emoji: '🏦', colorScheme: 'blue' },
    { type: 'dex', label: 'DEX', emoji: '🔗', colorScheme: 'cyan' },
    { type: 'wallet', label: 'Wallets', emoji: '💼', colorScheme: 'purple' },
    { type: 'broker', label: 'Brokers', emoji: '📊', colorScheme: 'green' },
    { type: 'bank', label: 'Banks', emoji: '🏛️', colorScheme: 'teal' },
    { type: 'investment', label: 'Investments', emoji: '📈', colorScheme: 'orange' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Colour dot rendered next to an entity name. */
const ColorDot: React.FC<{ color: string; size?: number }> = ({ color, size = 8 }) => (
    <Box
        as="span"
        display="inline-block"
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        bg={color}
        flexShrink={0}
    />
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ConnectorPickerModal: React.FC<ConnectorPickerModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    allConnectors,
    allAccounts,
    alreadySelected,
}) => {
    const { getAccountColor, getConnectorColor } = useEntityColors();

    // ── Internal selection state ────────────────────────────────────────
    const [selected, setSelected] = useState<Set<number>>(() => new Set(alreadySelected));
    const [search, setSearch] = useState('');

    // Reset internal state whenever the modal opens
    React.useEffect(() => {
        if (isOpen) {
            setSelected(new Set(alreadySelected));
            setSearch('');
        }
    }, [isOpen, alreadySelected]);

    // ── Derived data structures ────────────────────────────────────────

    // Connectors grouped by account ID
    const connectorsByAccount = useMemo(() => {
        const m = new Map<number, EnabledConnector[]>();
        for (const c of allConnectors) {
            const list = m.get(c.account_id) || [];
            list.push(c);
            m.set(c.account_id, list);
        }
        return m;
    }, [allConnectors]);

    // Normalised search term
    const searchLower = search.trim().toLowerCase();

    // Does a connector match the search?
    const connectorMatches = useCallback(
        (c: EnabledConnector): boolean => {
            if (!searchLower) return true;
            const haystack = [
                c.display_name,
                c.connector_type,
                c.chain_name,
                c.wallet_address,
                c.connector_family,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(searchLower);
        },
        [searchLower],
    );

    // Does an account (or any of its connectors) match the search?
    const accountMatches = useCallback(
        (account: AccountSummary): boolean => {
            if (!searchLower) return true;
            const acctHaystack = [
                account.name,
                account.account_type,
                account.group,
                account.address_or_identifier,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (acctHaystack.includes(searchLower)) return true;
            // Also match if any connector matches
            const cps = connectorsByAccount.get(account.id) || [];
            return cps.some(connectorMatches);
        },
        [searchLower, connectorsByAccount, connectorMatches],
    );

    // Helper: does the account name itself match (so all connectors should show)?
    const accountNameMatches = useCallback(
        (a: AccountSummary): boolean => {
            if (!searchLower) return true;
            return [a.name, a.account_type, a.group, a.address_or_identifier]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(searchLower);
        },
        [searchLower],
    );

    // Build flat sections: type → accounts (no group nesting)
    const sections = useMemo(() => {
        const result: {
            type: string;
            label: string;
            emoji: string;
            colorScheme: string;
            accounts: {
                account: AccountSummary;
                connectors: EnabledConnector[];
                visibleConnectors: EnabledConnector[];
            }[];
        }[] = [];

        for (const meta of TYPE_META) {
            const typeAccounts = allAccounts.filter(a => a.account_type === meta.type && accountMatches(a));
            if (typeAccounts.length === 0) continue;

            const mapped = typeAccounts.map(a => {
                const allCps = connectorsByAccount.get(a.id) || [];
                const visible = searchLower
                    ? allCps.filter(c => connectorMatches(c) || accountNameMatches(a))
                    : allCps;
                return { account: a, connectors: allCps, visibleConnectors: visible };
            });

            result.push({ ...meta, accounts: mapped });
        }
        return result;
    }, [allAccounts, connectorsByAccount, accountMatches, connectorMatches, accountNameMatches, searchLower]);

    // ── Selection helpers ──────────────────────────────────────────────

    const toggleConnector = (id: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAccount = (accountId: number) => {
        const cps = connectorsByAccount.get(accountId) || [];
        const ids = cps.map(c => c.connector_id);
        const allSelected = ids.every(id => selected.has(id));
        setSelected(prev => {
            const next = new Set(prev);
            if (allSelected) {
                ids.forEach(id => next.delete(id));
            } else {
                ids.forEach(id => next.add(id));
            }
            return next;
        });
    };

    const toggleType = (typeKey: string) => {
        const typeAccounts = allAccounts.filter(a => a.account_type === typeKey);
        const ids = typeAccounts.flatMap(a => (connectorsByAccount.get(a.id) || []).map(c => c.connector_id));
        const allSelected = ids.length > 0 && ids.every(id => selected.has(id));
        setSelected(prev => {
            const next = new Set(prev);
            if (allSelected) {
                ids.forEach(id => next.delete(id));
            } else {
                ids.forEach(id => next.add(id));
            }
            return next;
        });
    };

    const selectAll = () => {
        setSelected(new Set(allConnectors.map(c => c.connector_id)));
    };

    const clearSelection = () => {
        setSelected(new Set());
    };

    // ── Tri-state helpers ──────────────────────────────────────────────

    const accountCheckState = (accountId: number): { checked: boolean; indeterminate: boolean } => {
        const cps = connectorsByAccount.get(accountId) || [];
        if (cps.length === 0) return { checked: false, indeterminate: false };
        const count = cps.filter(c => selected.has(c.connector_id)).length;
        return { checked: count === cps.length, indeterminate: count > 0 && count < cps.length };
    };



    const typeCheckState = (typeKey: string): { checked: boolean; indeterminate: boolean } => {
        const typeAccounts = allAccounts.filter(a => a.account_type === typeKey);
        const ids = typeAccounts.flatMap(a => (connectorsByAccount.get(a.id) || []).map(c => c.connector_id));
        if (ids.length === 0) return { checked: false, indeterminate: false };
        const count = ids.filter(id => selected.has(id)).length;
        return { checked: count === ids.length, indeterminate: count > 0 && count < ids.length };
    };

    // ── Render ─────────────────────────────────────────────────────────

    return (
        <Dialog.Root
            open={isOpen}
            onOpenChange={e => {
                if (!e.open) onClose();
            }}
            size="xl"
        >
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="950px" maxH="85vh" display="flex" flexDirection="column">
                        {/* ── Header ─────────────────────────────── */}
                        <Dialog.Header pb={2}>
                            <Flex justify="space-between" align="center" w="100%">
                                <Dialog.Title fontSize="md">
                                    Add Accounts & Connectors
                                </Dialog.Title>
                                <Badge colorPalette="blue" size="sm">
                                    {selected.size} selected
                                </Badge>
                            </Flex>
                        </Dialog.Header>

                        {/* ── Search + Actions ───────────────────── */}
                        <Box px={6} pb={3}>
                            <Flex gap={2} align="center" mb={2}>
                                <Box position="relative" flex={1}>
                                    <Box position="absolute" left={2} top="50%" transform="translateY(-50%)" color="gray.400">
                                        <LuSearch size={14} />
                                    </Box>
                                    <Input
                                        size="sm"
                                        pl={8}
                                        placeholder="Search accounts, connectors, chains..."
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        autoFocus
                                    />
                                </Box>
                            </Flex>
                            <Flex gap={2} justify="flex-end">
                                <Button size="xs" variant="ghost" onClick={selectAll}>
                                    Select All
                                </Button>
                                <Button size="xs" variant="ghost" onClick={clearSelection}>
                                    Clear Selection
                                </Button>
                            </Flex>
                        </Box>

                        {/* ── Card grid body ─────────────────────── */}
                        <Dialog.Body pt={0} flex={1} overflowY="auto" px={6}>
                            {sections.length === 0 && (
                                <Box py={8} textAlign="center">
                                    <Text color="gray.500" fontSize="sm">
                                        {searchLower ? 'No accounts or connectors match your search.' : 'No connectors available.'}
                                    </Text>
                                </Box>
                            )}

                            <VStack align="stretch" gap={3}>
                                {sections.map(section => {
                                    const typeState = typeCheckState(section.type);

                                    return (
                                        <Box key={section.type}>
                                            {/* ── Type header ──── */}
                                            <Flex
                                                align="center"
                                                justify="space-between"
                                                py={1.5}
                                                px={2}
                                                bg={`${section.colorScheme}.50`}
                                                borderRadius="md"
                                                mb={2}
                                            >
                                                <Flex align="center" gap={2}>
                                                    <Text fontWeight="medium" fontSize="sm">
                                                        {section.emoji} {section.label}
                                                    </Text>
                                                    <Badge colorPalette="gray" size="xs" variant="subtle">
                                                        {section.accounts.length}
                                                    </Badge>
                                                </Flex>
                                                <Checkbox.Root
                                                    checked={typeState.indeterminate ? 'indeterminate' : typeState.checked}
                                                    onCheckedChange={() => toggleType(section.type)}
                                                    size="sm"
                                                >
                                                    <Checkbox.HiddenInput />
                                                    <Checkbox.Control>
                                                        <Checkbox.Indicator />
                                                    </Checkbox.Control>
                                                </Checkbox.Root>
                                            </Flex>

                                            {/* ── Account cards grid ──── */}
                                            <Grid
                                                templateColumns="repeat(auto-fill, minmax(260px, 1fr))"
                                                gap={2}
                                                px={1}
                                            >
                                                {section.accounts.map(({ account, connectors, visibleConnectors }) => {
                                                    const acctState = accountCheckState(account.id);
                                                    const acctColor = getAccountColor(account.id, account.name);
                                                    const selectedCount = connectors.filter(c => selected.has(c.connector_id)).length;

                                                    return (
                                                        <Card.Root
                                                            key={account.id}
                                                            size="sm"
                                                            variant="outline"
                                                            borderColor={acctState.checked ? 'blue.300' : acctState.indeterminate ? 'blue.200' : 'gray.200'}
                                                            bg={acctState.checked ? 'blue.50' : 'white'}
                                                        >
                                                            {/* Account header */}
                                                            <Card.Header
                                                                py={2}
                                                                px={3}
                                                                cursor="pointer"
                                                                onClick={() => toggleAccount(account.id)}
                                                                _hover={{ bg: 'gray.50' }}
                                                            >
                                                                <Flex justify="space-between" align="center">
                                                                    <Flex align="center" gap={2} minW={0} flex={1}>
                                                                        <ColorDot color={acctColor} />
                                                                        <VStack align="flex-start" gap={0} minW={0}>
                                                                            <Text
                                                                                fontSize="sm"
                                                                                fontWeight="semibold"
                                                                                color="gray.700"
                                                                                truncate
                                                                            >
                                                                                {account.name}
                                                                            </Text>
                                                                            {account.address_or_identifier && (
                                                                                <Text fontSize="2xs" color="gray.400" fontFamily="mono" truncate>
                                                                                    {formatAddress(account.address_or_identifier)}
                                                                                </Text>
                                                                            )}
                                                                        </VStack>
                                                                    </Flex>
                                                                    <Flex align="center" gap={2} flexShrink={0}>
                                                                        {account.group && (
                                                                            <Badge size="xs" colorPalette="cyan" variant="outline">
                                                                                {account.group}
                                                                            </Badge>
                                                                        )}
                                                                        <Text fontSize="2xs" color="gray.400">
                                                                            {selectedCount}/{connectors.length}
                                                                        </Text>
                                                                        <Box onClick={e => e.stopPropagation()}>
                                                                            <Checkbox.Root
                                                                                checked={acctState.indeterminate ? 'indeterminate' : acctState.checked}
                                                                                onCheckedChange={() => toggleAccount(account.id)}
                                                                                size="sm"
                                                                            >
                                                                                <Checkbox.HiddenInput />
                                                                                <Checkbox.Control>
                                                                                    <Checkbox.Indicator />
                                                                                </Checkbox.Control>
                                                                            </Checkbox.Root>
                                                                        </Box>
                                                                    </Flex>
                                                                </Flex>
                                                            </Card.Header>

                                                            {/* Connector list */}
                                                            <Card.Body pt={0} pb={2} px={3}>
                                                                <VStack align="stretch" gap={0}>
                                                                    {visibleConnectors.map(c => {
                                                                        const cColor = getConnectorColor(c.display_name || c.connector_type);
                                                                        const isChecked = selected.has(c.connector_id);

                                                                        return (
                                                                            <Flex
                                                                                key={c.connector_id}
                                                                                align="center"
                                                                                gap={2}
                                                                                py={0.5}
                                                                                px={1}
                                                                                _hover={{ bg: 'gray.50' }}
                                                                                borderRadius="sm"
                                                                                cursor="pointer"
                                                                                onClick={() => toggleConnector(c.connector_id)}
                                                                            >
                                                                                <Checkbox.Root
                                                                                    checked={isChecked}
                                                                                    onCheckedChange={() => toggleConnector(c.connector_id)}
                                                                                    size="sm"
                                                                                >
                                                                                    <Checkbox.HiddenInput />
                                                                                    <Checkbox.Control>
                                                                                        <Checkbox.Indicator />
                                                                                    </Checkbox.Control>
                                                                                </Checkbox.Root>
                                                                                <ColorDot color={cColor} size={6} />
                                                                                <Text
                                                                                    fontSize="xs"
                                                                                    color={isChecked ? 'gray.700' : 'gray.400'}
                                                                                    truncate
                                                                                    flex={1}
                                                                                >
                                                                                    {c.display_name || c.connector_type}
                                                                                </Text>
                                                                                {c.is_file_connector && (
                                                                                    <Badge colorPalette="blue" size="xs" variant="subtle">📁</Badge>
                                                                                )}
                                                                                {c.chain_name && (
                                                                                    <Badge colorPalette="purple" size="xs" variant="subtle">
                                                                                        {formatChainName(c.chain_name)}
                                                                                    </Badge>
                                                                                )}
                                                                            </Flex>
                                                                        );
                                                                    })}
                                                                </VStack>
                                                            </Card.Body>
                                                        </Card.Root>
                                                    );
                                                })}
                                            </Grid>
                                        </Box>
                                    );
                                })}
                            </VStack>
                        </Dialog.Body>

                        {/* ── Footer ─────────────────────────────── */}
                        <Dialog.Footer>
                            <Flex gap={3}>
                                <Button variant="outline" onClick={onClose}>
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="blue"
                                    onClick={() => onConfirm(selected)}
                                    disabled={selected.size === 0}
                                >
                                    Add Selected ({selected.size})
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};
