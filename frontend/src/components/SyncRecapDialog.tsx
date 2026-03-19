import React, { useMemo } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Dialog,
    Flex,
    Grid,
    Portal,
    Text,
} from '@chakra-ui/react';
import {
    ConnectorOverride,
    EnabledConnector,
    AccountSummary,
} from '../types';

interface SyncRecapDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    connectors: EnabledConnector[];
    accounts: AccountSummary[];
    overrides: ConnectorOverride[];
    renormalize?: boolean;
    loading?: boolean;
}

const formatDateTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return isoString;
    }
};

export const SyncRecapDialog: React.FC<SyncRecapDialogProps> = ({
    isOpen,
    onClose,
    onConfirm,
    connectors,
    accounts,
    overrides,
    renormalize = false,
    loading = false,
}) => {
    const overridesMap = useMemo(() => {
        const map = new Map<number, ConnectorOverride>();
        for (const o of overrides) map.set(o.connector_id, o);
        return map;
    }, [overrides]);

    // Compute effective enabled state for each connector
    const getEffectiveEnabled = (c: EnabledConnector): boolean => {
        const override = overridesMap.get(c.connector_id);
        if (override?.enabled !== undefined) return override.enabled;
        return c.enabled && (c.account_enabled ?? true);
    };

    const enabledConnectors = connectors.filter(c => getEffectiveEnabled(c));
    const disabledConnectors = connectors.filter(c => !getEffectiveEnabled(c));
    const enabledAccountIds = new Set(enabledConnectors.map(c => c.account_id));
    const enabledAccounts = accounts.filter(a => enabledAccountIds.has(a.id));
    const overriddenConnectors = enabledConnectors.filter(c => overridesMap.has(c.connector_id));
    const testModeConnectors = enabledConnectors.filter(c => {
        const o = overridesMap.get(c.connector_id);
        return o?.test_mode ?? c.test_mode;
    });
    const fileConnectors = enabledConnectors.filter(c => c.is_file_connector);

    // Group enabled connectors by account type → account name
    const grouped = useMemo(() => {
        const typeLabels: Record<string, string> = {
            cex: '🏦 Exchanges', dex: '🔗 DEX', wallet: '💼 Wallets',
            broker: '📊 Brokers', bank: '🏛️ Banks', investment: '📈 Investments',
        };
        const typeOrder = ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment', 'other'];
        const map = new Map<string, Map<string, EnabledConnector[]>>();

        for (const c of enabledConnectors) {
            const t = c.account_type || 'other';
            const a = c.account_name;
            if (!map.has(t)) map.set(t, new Map());
            const acctMap = map.get(t)!;
            if (!acctMap.has(a)) acctMap.set(a, []);
            acctMap.get(a)!.push(c);
        }

        const sorted = Array.from(map.entries()).sort(
            ([a], [b]) => (typeOrder.indexOf(a) === -1 ? 99 : typeOrder.indexOf(a)) - (typeOrder.indexOf(b) === -1 ? 99 : typeOrder.indexOf(b))
        );

        return { sorted, typeLabels };
    }, [enabledConnectors]);

    // Flatten all connectors into per-account cards
    const accountCards = useMemo(() => {
        const cards: { accountName: string; accountType: string; connectors: EnabledConnector[] }[] = [];
        for (const [, acctMap] of grouped.sorted) {
            for (const [acctName, cps] of acctMap.entries()) {
                const acctType = cps[0]?.account_type || '';
                cards.push({ accountName: acctName, accountType: acctType, connectors: cps });
            }
        }
        return cards;
    }, [grouped]);

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }} size="xl">
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="900px">
                        <Dialog.Header>
                            <Flex justify="space-between" align="center" w="100%">
                                <Dialog.Title fontSize="md">
                                    {renormalize ? '🔄 Re-Normalize Confirmation' : '🚀 Sync Job Summary'}
                                </Dialog.Title>
                                <Flex gap={3} align="center">
                                    <Flex align="center" gap={1}>
                                        <Text fontSize="xs" color="gray.500">Connectors</Text>
                                        <Text fontSize="sm" fontWeight="bold">{enabledConnectors.length}</Text>
                                    </Flex>
                                    <Flex align="center" gap={1}>
                                        <Text fontSize="xs" color="gray.500">Accounts</Text>
                                        <Text fontSize="sm" fontWeight="bold">{enabledAccounts.length}</Text>
                                    </Flex>
                                    {disabledConnectors.length > 0 && (
                                        <Flex align="center" gap={1}>
                                            <Text fontSize="xs" color="gray.400">Skipped</Text>
                                            <Text fontSize="sm" fontWeight="bold" color="gray.400">{disabledConnectors.length}</Text>
                                        </Flex>
                                    )}
                                    {overriddenConnectors.length > 0 && (
                                        <Badge colorPalette="orange" size="sm">{overriddenConnectors.length} override{overriddenConnectors.length !== 1 ? 's' : ''}</Badge>
                                    )}
                                    {testModeConnectors.length > 0 && (
                                        <Badge colorPalette="orange" size="sm">🧪 {testModeConnectors.length} test</Badge>
                                    )}
                                </Flex>
                            </Flex>
                        </Dialog.Header>

                        <Dialog.Body pt={2}>
                            {/* Warning for renormalize */}
                            {renormalize && (
                                <Box bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={2} mb={3}>
                                    <Text fontSize="xs" color="orange.700" fontWeight="medium">
                                        ⚠️ Re-normalization will delete existing normalized transactions and recreate them from stored raw data.
                                        Derived data (cost lots, P&L) will also be removed.
                                    </Text>
                                </Box>
                            )}

                            {/* Warnings */}
                            {fileConnectors.length > 0 && (
                                <Box bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md" p={2} mb={3}>
                                    <Text fontSize="xs" color="blue.700">
                                        📁 {fileConnectors.length} file connector{fileConnectors.length > 1 ? 's' : ''} included — ensure files are uploaded before syncing.
                                    </Text>
                                </Box>
                            )}

                            {/* Account cards in 3-column grid */}
                            <Box maxH="450px" overflowY="auto">
                                <Grid templateColumns="repeat(3, 1fr)" gap={2}>
                                    {accountCards.map(({ accountName, accountType, connectors: cps }) => (
                                        <Card.Root key={accountName} size="sm" variant="outline">
                                            <Card.Header py={1.5} px={3}>
                                                <Flex align="center" gap={1.5}>
                                                    <Text fontSize="xs" fontWeight="semibold" color="gray.700" truncate>
                                                        {accountName}
                                                    </Text>
                                                    <Badge colorPalette="gray" size="xs" variant="subtle">{accountType}</Badge>
                                                </Flex>
                                            </Card.Header>
                                            <Card.Body py={1} px={3}>
                                                {cps.map(c => {
                                                    const o = overridesMap.get(c.connector_id);
                                                    const hasOverride = !!o;
                                                    const isTest = o?.test_mode ?? c.test_mode;
                                                    const since = o?.since_datetime !== undefined ? o.since_datetime : (c.default_since_datetime ?? c.start_datetime ?? null);
                                                    const symbols = o?.symbols;
                                                    const currencies = o?.currencies;

                                                    // Collect which fields were overridden
                                                    const overriddenFields: string[] = [];
                                                    if (o?.enabled !== undefined) overriddenFields.push('enabled');
                                                    if (o?.test_mode !== undefined) overriddenFields.push('test mode');
                                                    if (o?.since_datetime !== undefined) overriddenFields.push('since date');
                                                    if (o?.symbols && o.symbols.length > 0) overriddenFields.push('symbols');
                                                    if (o?.currencies && o.currencies.length > 0) overriddenFields.push('currencies');

                                                    return (
                                                        <Box key={c.connector_id} py={0.5} pl={hasOverride ? 1.5 : 0} borderLeftWidth={hasOverride ? '2px' : 0} borderColor="orange.400">
                                                            <Flex align="center" gap={1} flexWrap="wrap">
                                                                <Text fontSize="xs" color="gray.700" truncate>
                                                                    {c.display_name || c.connector_type}
                                                                </Text>
                                                                {c.is_file_connector && (
                                                                    <Badge colorPalette="blue" size="xs" variant="subtle">📁</Badge>
                                                                )}
                                                                {isTest && (
                                                                    <Badge colorPalette="orange" size="xs">🧪</Badge>
                                                                )}
                                                                {c.chain_name && (
                                                                    <Badge colorPalette="purple" size="xs" variant="subtle">{c.chain_name}</Badge>
                                                                )}
                                                            </Flex>
                                                            {overriddenFields.length > 0 && (
                                                                <Text fontSize="2xs" color="orange.500" truncate>
                                                                    ⚙ {overriddenFields.join(', ')}
                                                                </Text>
                                                            )}
                                                            {since && (
                                                                <Text fontSize="2xs" color="gray.400">since {formatDateTime(since)}</Text>
                                                            )}
                                                            {!since && c.supports_incremental_sync && (
                                                                <Text fontSize="2xs" color="orange.500">⚠ full sync</Text>
                                                            )}
                                                            {symbols && symbols.length > 0 && (
                                                                <Text fontSize="2xs" color="blue.500" truncate>{symbols.join(', ')}</Text>
                                                            )}
                                                            {currencies && currencies.length > 0 && (
                                                                <Text fontSize="2xs" color="blue.500" truncate>{currencies.join(', ')}</Text>
                                                            )}
                                                        </Box>
                                                    );
                                                })}
                                            </Card.Body>
                                        </Card.Root>
                                    ))}
                                </Grid>
                            </Box>
                        </Dialog.Body>

                        <Dialog.Footer>
                            <Flex gap={3}>
                                <Button variant="outline" onClick={onClose} disabled={loading}>
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette={renormalize ? 'purple' : 'blue'}
                                    onClick={onConfirm}
                                    loading={loading}
                                >
                                    {renormalize ? '🔄 Re-Normalize' : '🚀 Start Sync'}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};
