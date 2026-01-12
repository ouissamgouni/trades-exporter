import {
    Badge,
    Box,
    Button,
    Card,
    Checkbox,
    Collapsible,
    Flex,
    Grid,
    Spinner,
    Stack,
    Switch,
    Text,
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    API_URL,
    ConnectorOverride,
    EnabledConnector,
    AccountSummary,
    AllConnectorsResponse,
} from '../types';

interface SyncConfigPanelProps {
    onOverridesChange: (overrides: ConnectorOverride[]) => void;
    disabled?: boolean;
}

// Account Card component - one card per account with connector list inside
const AccountCard: React.FC<{
    account: AccountSummary;
    connectors: EnabledConnector[];
    overrides: Map<number, ConnectorOverride>;
    accountOverride?: boolean;
    getEffectiveEnabled: (connector: EnabledConnector) => boolean;
    onAccountToggle: (enabled: boolean) => void;
    onConnectorEnabledChange: (connectorId: number, enabled: boolean, defaultEnabled: boolean) => void;
    onTestModeChange: (connectorId: number, testMode: boolean, defaultTestMode: boolean) => void;
    disabled?: boolean;
}> = ({
    account,
    connectors,
    overrides,
    accountOverride,
    getEffectiveEnabled,
    onAccountToggle,
    onConnectorEnabledChange,
    onTestModeChange,
    disabled,
}) => {
        const enabledCount = connectors.filter(c => getEffectiveEnabled(c)).length;
        const hasOverride = accountOverride !== undefined || connectors.some(c => overrides.has(c.connector_id));
        const allEnabled = enabledCount === connectors.length;

        return (
            <Card.Root
                variant="outline"
                size="sm"
                borderColor={hasOverride ? 'orange.300' : 'gray.200'}
                bg={hasOverride ? 'orange.50' : 'white'}
            >
                <Card.Header pb={2} pt={3} px={3}>
                    <Flex justify="space-between" align="center">
                        <Flex align="center" gap={2}>
                            <Text fontWeight="semibold" fontSize="sm" color="gray.700">
                                {account.name}
                            </Text>
                            <Badge
                                size="xs"
                                colorPalette={account.account_type === 'exchange' ? 'purple' : 'teal'}
                                variant="subtle"
                            >
                                {account.account_type}
                            </Badge>
                        </Flex>
                        <Flex align="center" gap={2}>
                            <Text fontSize="xs" color="gray.500">
                                {enabledCount}/{connectors.length}
                            </Text>
                            <Switch.Root
                                checked={allEnabled}
                                disabled={disabled}
                                onCheckedChange={(details) => onAccountToggle(details.checked)}
                                size="sm"
                            >
                                <Switch.HiddenInput />
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch.Root>
                        </Flex>
                    </Flex>
                </Card.Header>
                <Card.Body pt={0} pb={3} px={3}>
                    <Stack gap={1.5}>
                        {connectors.map((connector) => {
                            const override = overrides.get(connector.connector_id);
                            const isEnabled = getEffectiveEnabled(connector);
                            const isTestMode = override?.test_mode ?? connector.test_mode;
                            const hasEnabledOverride = override?.enabled !== undefined || accountOverride !== undefined;
                            const hasTestModeOverride = override?.test_mode !== undefined;
                            const defaultEnabled = connector.enabled && (connector.account_enabled ?? true);

                            return (
                                <Flex
                                    key={connector.connector_id}
                                    justify="space-between"
                                    align="center"
                                    py={1}
                                    px={1.5}
                                    borderRadius="sm"
                                    bg={hasEnabledOverride || hasTestModeOverride ? 'orange.100' : 'transparent'}
                                    _hover={{ bg: hasEnabledOverride || hasTestModeOverride ? 'orange.100' : 'gray.50' }}
                                >
                                    <Checkbox.Root
                                        checked={isEnabled}
                                        disabled={disabled}
                                        onCheckedChange={(details) =>
                                            onConnectorEnabledChange(connector.connector_id, !!details.checked, defaultEnabled)
                                        }
                                        size="sm"
                                    >
                                        <Checkbox.HiddenInput />
                                        <Checkbox.Control>
                                            <Checkbox.Indicator />
                                        </Checkbox.Control>
                                        <Checkbox.Label>
                                            <Text
                                                fontSize="sm"
                                                color={isEnabled ? 'gray.700' : 'gray.400'}
                                                textDecoration={isEnabled ? undefined : 'line-through'}
                                            >
                                                {connector.connector_type}
                                            </Text>
                                        </Checkbox.Label>
                                    </Checkbox.Root>
                                    <Flex align="center" gap={1.5}>
                                        {hasTestModeOverride && (
                                            <Badge colorPalette="purple" size="xs" variant="subtle">🧪</Badge>
                                        )}
                                        <Text fontSize="2xs" color="gray.400">Test</Text>
                                        <Switch.Root
                                            checked={isTestMode}
                                            disabled={disabled || !isEnabled}
                                            onCheckedChange={(details) =>
                                                onTestModeChange(connector.connector_id, details.checked, connector.test_mode)
                                            }
                                            size="sm"
                                        >
                                            <Switch.HiddenInput />
                                            <Switch.Control>
                                                <Switch.Thumb />
                                            </Switch.Control>
                                        </Switch.Root>
                                    </Flex>
                                </Flex>
                            );
                        })}
                    </Stack>
                </Card.Body>
            </Card.Root>
        );
    };

export const SyncConfigPanel: React.FC<SyncConfigPanelProps> = ({
    onOverridesChange,
    disabled = false,
}) => {
    const [connectors, setConnectors] = useState<EnabledConnector[]>([]);
    const [accounts, setAccounts] = useState<AccountSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);

    // Track overrides as a map: connector_id -> override settings
    const [overrides, setOverrides] = useState<Map<number, ConnectorOverride>>(new Map());

    // Track account-level overrides (enabling/disabling all connectors for an account)
    const [accountOverrides, setAccountOverrides] = useState<Map<number, boolean>>(new Map());

    // Fetch all connectors
    const fetchConnectors = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch(`${API_URL}/sync-job/all-connectors`);
            if (!response.ok) throw new Error('Failed to fetch connectors');
            const data: AllConnectorsResponse = await response.json();
            setConnectors(data.connectors);
            setAccounts(data.accounts);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchConnectors();
    }, [fetchConnectors]);

    // Group connectors by account
    const connectorsByAccount = useMemo(() => {
        const grouped = new Map<number, EnabledConnector[]>();
        for (const connector of connectors) {
            const list = grouped.get(connector.account_id) || [];
            list.push(connector);
            grouped.set(connector.account_id, list);
        }
        return grouped;
    }, [connectors]);

    // Calculate effective enabled state for each connector
    const getEffectiveEnabled = useCallback((connector: EnabledConnector) => {
        const override = overrides.get(connector.connector_id);
        if (override?.enabled !== undefined) return override.enabled;

        // Check account-level override
        const accountOverride = accountOverrides.get(connector.account_id);
        if (accountOverride !== undefined) return accountOverride;

        // Default to connector's base enabled state AND account's enabled state
        return connector.enabled && (connector.account_enabled ?? true);
    }, [overrides, accountOverrides]);

    // Update parent when overrides change
    useEffect(() => {
        const overrideList: ConnectorOverride[] = [];

        // Add explicit connector overrides
        for (const [connectorId, override] of overrides) {
            if (override.enabled !== undefined || override.test_mode !== undefined) {
                overrideList.push(override);
            }
        }

        // Add account-level overrides as individual connector overrides
        for (const [accountId, enabled] of accountOverrides) {
            const accountConnectors = connectorsByAccount.get(accountId) || [];
            for (const connector of accountConnectors) {
                // Only add if not already explicitly overridden
                if (!overrides.has(connector.connector_id)) {
                    overrideList.push({
                        connector_id: connector.connector_id,
                        enabled,
                    });
                }
            }
        }

        onOverridesChange(overrideList);
    }, [overrides, accountOverrides, connectorsByAccount, onOverridesChange]);

    const handleConnectorEnabledChange = (connectorId: number, enabled: boolean, defaultEnabled: boolean) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (enabled === defaultEnabled) {
                const { enabled: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, enabled });
            }
            return next;
        });
    };

    const handleTestModeChange = (connectorId: number, testMode: boolean, defaultTestMode: boolean) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (testMode === defaultTestMode) {
                const { test_mode: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, test_mode: testMode });
            }
            return next;
        });
    };

    const handleAccountToggle = (accountId: number, enabled: boolean) => {
        // Clear any individual connector overrides for this account first
        setOverrides(prev => {
            const next = new Map(prev);
            const accountConnectors = connectorsByAccount.get(accountId) || [];
            for (const c of accountConnectors) {
                next.delete(c.connector_id);
            }
            return next;
        });

        // Determine if this matches the default state
        const account = accounts.find(a => a.id === accountId);
        const accountConnectors = connectorsByAccount.get(accountId) || [];
        const defaultEnabled = account?.enabled && accountConnectors.some(c => c.enabled);

        setAccountOverrides(prev => {
            const next = new Map(prev);
            if (enabled === defaultEnabled) {
                next.delete(accountId);
            } else {
                next.set(accountId, enabled);
            }
            return next;
        });
    };

    const selectAll = () => {
        setOverrides(new Map());
        setAccountOverrides(new Map());
        // Set all accounts to enabled if they weren't by default
        const newAccountOverrides = new Map<number, boolean>();
        for (const account of accounts) {
            if (!account.enabled) {
                newAccountOverrides.set(account.id, true);
            }
        }
        // Set all connectors to enabled if they weren't by default
        const newOverrides = new Map<number, ConnectorOverride>();
        for (const connector of connectors) {
            if (!connector.enabled) {
                newOverrides.set(connector.connector_id, {
                    connector_id: connector.connector_id,
                    enabled: true,
                });
            }
        }
        setAccountOverrides(newAccountOverrides);
        setOverrides(newOverrides);
    };

    const selectNone = () => {
        setOverrides(new Map());
        const newAccountOverrides = new Map<number, boolean>();
        for (const account of accounts) {
            newAccountOverrides.set(account.id, false);
        }
        setAccountOverrides(newAccountOverrides);
    };

    const resetOverrides = () => {
        setOverrides(new Map());
        setAccountOverrides(new Map());
    };

    const hasOverrides = overrides.size > 0 || accountOverrides.size > 0;
    const enabledCount = connectors.filter(c => getEffectiveEnabled(c)).length;

    if (loading) {
        return (
            <Box p={4} textAlign="center">
                <Spinner size="sm" />
                <Text fontSize="sm" color="gray.500" mt={2}>
                    Loading connectors...
                </Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box p={3} bg="red.50" borderRadius="md" borderWidth="1px" borderColor="red.200">
                <Text color="red.600" fontSize="sm">
                    Failed to load connectors: {error}
                </Text>
                <Button size="xs" mt={2} onClick={fetchConnectors} colorPalette="red" variant="outline">
                    Retry
                </Button>
            </Box>
        );
    }

    if (connectors.length === 0) {
        return (
            <Box p={3} bg="yellow.50" borderRadius="md" borderWidth="1px" borderColor="yellow.200">
                <Text color="yellow.700" fontSize="sm">
                    No connectors found. Configure connectors in Settings → Accounts.
                </Text>
            </Box>
        );
    }

    return (
        <Box
            borderWidth="1px"
            borderColor={hasOverrides ? 'orange.300' : 'gray.200'}
            borderRadius="lg"
            overflow="hidden"
            bg="white"
        >
            {/* Header */}
            <Box
                p={3}
                bg={hasOverrides ? 'orange.50' : 'gray.50'}
                cursor="pointer"
                onClick={() => setExpanded(!expanded)}
                _hover={{ bg: hasOverrides ? 'orange.100' : 'gray.100' }}
                transition="background 0.15s"
            >
                <Flex justify="space-between" align="center">
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" color="gray.700">⚙️ Sync Configuration</Text>
                        <Badge colorPalette="blue" size="sm" variant="subtle">
                            {enabledCount}/{connectors.length} enabled
                        </Badge>
                        {hasOverrides && (
                            <Badge colorPalette="orange" size="sm" variant="subtle">
                                modified
                            </Badge>
                        )}
                    </Flex>
                    <Text color="gray.400" fontSize="sm">{expanded ? '▼' : '▶'}</Text>
                </Flex>
                <Text fontSize="xs" color="gray.500" mt={1}>
                    Configure which connectors to include and their test mode settings
                </Text>
            </Box>

            {/* Expanded content */}
            <Collapsible.Root open={expanded}>
                <Collapsible.Content>
                    <Box p={3} borderTopWidth="1px" borderColor="gray.100" bg="white">
                        {/* Action buttons */}
                        <Flex justify="flex-end" gap={1} mb={3}>
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    selectAll();
                                }}
                                disabled={disabled}
                            >
                                All
                            </Button>
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    selectNone();
                                }}
                                disabled={disabled}
                            >
                                None
                            </Button>
                            {hasOverrides && (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="orange"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        resetOverrides();
                                    }}
                                    disabled={disabled}
                                >
                                    Reset
                                </Button>
                            )}
                        </Flex>

                        {/* Account Cards Grid - auto-fill for maximum horizontal usage */}
                        <Grid
                            templateColumns="repeat(auto-fill, minmax(280px, 1fr))"
                            gap={3}
                        >
                            {accounts.map((account) => {
                                const accountConnectors = connectorsByAccount.get(account.id) || [];
                                if (accountConnectors.length === 0) return null;

                                return (
                                    <AccountCard
                                        key={account.id}
                                        account={account}
                                        connectors={accountConnectors}
                                        overrides={overrides}
                                        accountOverride={accountOverrides.get(account.id)}
                                        getEffectiveEnabled={getEffectiveEnabled}
                                        onAccountToggle={(enabled) => handleAccountToggle(account.id, enabled)}
                                        onConnectorEnabledChange={handleConnectorEnabledChange}
                                        onTestModeChange={handleTestModeChange}
                                        disabled={disabled}
                                    />
                                );
                            })}
                        </Grid>
                    </Box>
                </Collapsible.Content>
            </Collapsible.Root>
        </Box>
    );
};
