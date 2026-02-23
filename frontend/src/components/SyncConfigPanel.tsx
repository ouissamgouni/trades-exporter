import {
    Badge,
    Box,
    Button,
    Card,
    Checkbox,
    Collapsible,
    Flex,
    Grid,
    HStack,
    IconButton,
    Input,
    Spinner,
    Stack,
    Switch,
    Text,
    Tooltip,
    VStack,
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuRotateCcw, LuX, LuChevronRight, LuChevronDown } from 'react-icons/lu';
import { FiDollarSign } from 'react-icons/fi';
import {
    API_URL,
    ConnectorOverride,
    EnabledConnector,
    AccountSummary,
    AllConnectorsResponse,
} from '../types';
import { ConnectorFileUpload } from './ConnectorFileUpload';
import { ConnectorJobSnippet } from './ConnectorJobSnippet';
import { JobDetailDrawer } from './JobDetailDrawer';
import { BalanceDrawer } from './BalanceDrawer';
import { formatAddress, formatChainName } from '../utils/addressUtils';

interface SyncConfigPanelProps {
    onOverridesChange: (overrides: ConnectorOverride[]) => void;
    disabled?: boolean;
}

// Format datetime for input
const formatForInput = (isoString: string | null | undefined): string => {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        return date.toISOString().slice(0, 16);
    } catch {
        return '';
    }
};

// Format datetime for display
const formatDateTime = (isoString: string | null | undefined): string => {
    if (!isoString) return 'None';
    try {
        const date = new Date(isoString);
        return date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return isoString;
    }
};

// Comma-separated input component that handles typing properly
const CommaSeparatedInput: React.FC<{
    value: string[] | null;
    onChange: (values: string[] | null) => void;
    placeholder?: string;
    disabled?: boolean;
    uppercase?: boolean;
}> = ({ value, onChange, placeholder, disabled, uppercase }) => {
    const [localValue, setLocalValue] = React.useState(value?.join(', ') ?? '');

    // Sync local value when external value changes
    React.useEffect(() => {
        setLocalValue(value?.join(', ') ?? '');
    }, [value]);

    const handleBlur = () => {
        const trimmed = localValue.trim();
        if (!trimmed) {
            onChange(null);
        } else {
            let items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
            if (uppercase) {
                items = items.map(s => s.toUpperCase());
            }
            onChange(items.length > 0 ? items : null);
        }
    };

    return (
        <Input
            type="text"
            size="xs"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            placeholder={placeholder}
            flex={1}
            disabled={disabled}
        />
    );
};

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
    onSinceChange: (connectorId: number, since: string | null, defaultSince: string | null) => void;
    onSinceReset: (connectorId: number) => void;
    onSinceClear: (connectorId: number) => void;
    onSymbolsChange: (connectorId: number, symbols: string[] | null) => void;
    onCurrenciesChange: (connectorId: number, currencies: string[] | null) => void;
    onFileUploadComplete: (connectorId: number) => void;
    onJobSnippetClick: (connector: EnabledConnector) => void;
    onBalanceClick: (accountId: number) => void;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
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
    onSinceChange,
    onSinceReset,
    onSinceClear,
    onSymbolsChange,
    onCurrenciesChange,
    onFileUploadComplete,
    onJobSnippetClick,
    onBalanceClick,
    isCollapsed,
    onToggleCollapse,
    disabled,
}) => {
        const enabledCount = connectors.filter(c => getEffectiveEnabled(c)).length;
        const hasOverride = accountOverride !== undefined || connectors.some(c => overrides.has(c.connector_id));
        const allEnabled = enabledCount === connectors.length;
        const accountDisabled = enabledCount === 0;  // Check if no connectors are enabled

        // If collapsed, show minimal horizontal card
        if (isCollapsed) {
            return (
                <Card.Root
                    variant="outline"
                    size="sm"
                    borderColor="gray.200"
                    bg="gray.50"
                    opacity={0.7}
                    cursor="pointer"
                    onClick={onToggleCollapse}
                    _hover={{ opacity: 1, borderColor: "gray.300" }}
                    transition="all 0.2s"
                    width="140px"
                    flexShrink={0}
                >
                    <Card.Body py={2} px={3}>
                        <VStack gap={1} align="center">
                            <LuChevronRight size={16} color="gray" />
                            <Text fontSize="xs" color="gray.600" fontWeight="medium" textAlign="center" lineHeight="tight">
                                {account.name}
                            </Text>
                            <Badge size="xs" colorPalette="gray" variant="subtle">
                                {connectors.length}
                            </Badge>
                        </VStack>
                    </Card.Body>
                </Card.Root>
            );
        }

        return (
            <Card.Root
                variant="outline"
                size="sm"
                borderColor={hasOverride ? 'orange.300' : 'gray.200'}
                bg={hasOverride ? 'orange.50' : 'white'}
                opacity={accountDisabled && !allEnabled ? 0.8 : 1}
                flex="1 1 280px"
                minW="280px"
            >
                <Card.Header pb={2} pt={3} px={3}>
                    <Flex justify="space-between" align="center">
                        <Flex align="center" gap={2}>
                            <Box
                                as="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleCollapse();
                                }}
                                cursor="pointer"
                                color="gray.400"
                                _hover={{ color: "gray.600" }}
                            >
                                <LuChevronDown size={14} />
                            </Box>
                            <VStack align="flex-start" gap={0}>
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
                                    {account.group && (
                                        <Badge size="xs" colorPalette="cyan" variant="outline">
                                            {account.group}
                                        </Badge>
                                    )}
                                </Flex>
                                {account.address_or_identifier && (
                                    <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                        {formatAddress(account.address_or_identifier)}
                                    </Text>
                                )}
                            </VStack>
                        </Flex>
                        <Flex align="center" gap={2}>
                            <Tooltip.Root positioning={{ placement: "top" }} openDelay={300}>
                                <Tooltip.Trigger asChild>
                                    <IconButton
                                        aria-label="View balance"
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette="green"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onBalanceClick(account.id);
                                        }}
                                    >
                                        <FiDollarSign size={13} />
                                    </IconButton>
                                </Tooltip.Trigger>
                                <Tooltip.Positioner>
                                    <Tooltip.Content>View live balance</Tooltip.Content>
                                </Tooltip.Positioner>
                            </Tooltip.Root>
                            <Text fontSize="xs" color="gray.500">
                                {enabledCount}/{connectors.length}
                            </Text>
                            <Tooltip.Root
                                positioning={{ placement: "top" }}
                                openDelay={300}
                            >
                                <Tooltip.Trigger asChild>
                                    <Box display="inline-flex">
                                        <Checkbox.Root
                                            checked={allEnabled}
                                            indeterminate={enabledCount > 0 && !allEnabled}
                                            disabled={disabled}
                                            onCheckedChange={(details) => {
                                                // Determine if we're in mixed state
                                                const isMixed = enabledCount > 0 && !allEnabled;
                                                // When in mixed state, always enable all
                                                // When all enabled, disable all
                                                // When none enabled, enable all
                                                onAccountToggle(isMixed ? true : !!details.checked);
                                            }}
                                            size="sm"
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control>
                                                <Checkbox.Indicator />
                                            </Checkbox.Control>
                                        </Checkbox.Root>
                                    </Box>
                                </Tooltip.Trigger>
                                <Tooltip.Positioner>
                                    <Tooltip.Content>
                                        {(() => {
                                            if (allEnabled) {
                                                return "Click to disable all connectors for this account";
                                            }
                                            if (enabledCount > 0) {
                                                return `${enabledCount} of ${connectors.length} enabled - Click to enable all`;
                                            }
                                            return "Click to enable all connectors for this account";
                                        })()}
                                    </Tooltip.Content>
                                </Tooltip.Positioner>
                            </Tooltip.Root>
                        </Flex>
                    </Flex>
                </Card.Header>
                <Card.Body pt={0} pb={3} px={3}>
                    <Stack gap={2}>
                        {connectors.map((connector) => {
                            const override = overrides.get(connector.connector_id);
                            const isEnabled = getEffectiveEnabled(connector);
                            const isTestMode = override?.test_mode ?? connector.test_mode;
                            const hasEnabledOverride = override?.enabled !== undefined || accountOverride !== undefined;
                            const hasTestModeOverride = override?.test_mode !== undefined;
                            const defaultEnabled = connector.enabled && (connector.account_enabled ?? true);

                            // Since datetime handling
                            const supportsIncremental = connector.supports_incremental_sync ?? false;
                            const defaultSince = connector.default_since_datetime ?? null;
                            const currentSince = override?.since_datetime !== undefined
                                ? override.since_datetime
                                : defaultSince;
                            const hasSinceOverride = override?.since_datetime !== undefined;
                            const isFullSync = currentSince === null || currentSince === '';

                            // Symbols/Currencies handling
                            const optionalConfig = connector.optional_config || [];
                            const supportsSymbols = optionalConfig.includes('symbols');
                            const supportsCurrencies = optionalConfig.includes('currencies');
                            const hasSymbolsOverride = override?.symbols !== undefined;
                            const hasCurrenciesOverride = override?.currencies !== undefined;
                            const currentSymbols = override?.symbols ?? null;
                            const currentCurrencies = override?.currencies ?? null;

                            const hasAnyOverride = hasEnabledOverride || hasTestModeOverride || hasSinceOverride || hasSymbolsOverride || hasCurrenciesOverride;

                            return (
                                <Box
                                    key={connector.connector_id}
                                    py={2}
                                    px={2}
                                    borderRadius="md"
                                    bg={hasAnyOverride ? 'orange.50' : 'transparent'}
                                    borderWidth={hasAnyOverride ? '1px' : '0'}
                                    borderColor="orange.200"
                                >
                                    {/* Row 1: Checkbox, Name, Test toggle */}
                                    <Flex justify="space-between" align="center">
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
                                                <VStack align="flex-start" gap={0}>
                                                    <Flex align="center" gap={1.5}>
                                                        <Text
                                                            fontSize="sm"
                                                            color={isEnabled ? 'gray.700' : 'gray.400'}
                                                            textDecoration={isEnabled ? undefined : 'line-through'}
                                                        >
                                                            {connector.display_name || connector.connector_type}
                                                        </Text>
                                                        {connector.is_file_connector && (
                                                            <Badge colorPalette="blue" size="xs" variant="subtle">📁 File</Badge>
                                                        )}
                                                        {connector.chain_name && (
                                                            <Badge colorPalette="purple" size="xs" variant="subtle">
                                                                {formatChainName(connector.chain_name)}
                                                            </Badge>
                                                        )}
                                                    </Flex>
                                                    {connector.wallet_address && (
                                                        <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                                            {formatAddress(connector.wallet_address)}
                                                        </Text>
                                                    )}
                                                </VStack>
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

                                    {/* Row 2: Since datetime picker (only for incremental sync connectors when enabled) */}
                                    {supportsIncremental && isEnabled && (
                                        <Flex align="center" gap={2} mt={2} pl={6}>
                                            <Text fontSize="xs" color="gray.500" minW="35px">Since:</Text>
                                            <Input
                                                type="datetime-local"
                                                size="xs"
                                                value={formatForInput(currentSince)}
                                                onChange={(e) => {
                                                    const value = e.target.value
                                                        ? new Date(e.target.value).toISOString()
                                                        : null;
                                                    onSinceChange(connector.connector_id, value, defaultSince);
                                                }}
                                                flex={1}
                                                maxW="180px"
                                                disabled={disabled}
                                            />
                                            {/* Reset to default button */}
                                            <IconButton
                                                aria-label="Reset to default"
                                                size="xs"
                                                variant="ghost"
                                                onClick={() => onSinceReset(connector.connector_id)}
                                                title={`Reset to default: ${formatDateTime(defaultSince)}`}
                                                disabled={disabled || !hasSinceOverride}
                                            >
                                                <LuRotateCcw size={12} />
                                            </IconButton>
                                            {/* Clear for full sync button */}
                                            <IconButton
                                                aria-label="Clear for full sync"
                                                size="xs"
                                                variant="ghost"
                                                colorPalette={isFullSync ? 'orange' : 'gray'}
                                                onClick={() => onSinceClear(connector.connector_id)}
                                                title="Clear for full sync"
                                                disabled={disabled}
                                            >
                                                <LuX size={12} />
                                            </IconButton>
                                            {/* Status badges */}
                                            {hasSinceOverride && !isFullSync && (
                                                <Badge colorPalette="blue" size="xs" variant="subtle">modified</Badge>
                                            )}
                                            {isFullSync && (
                                                <Badge colorPalette="orange" size="xs" variant="subtle">⚠️ full sync</Badge>
                                            )}
                                            {!hasSinceOverride && !isFullSync && (
                                                <Badge colorPalette="gray" size="xs" variant="subtle">auto</Badge>
                                            )}
                                        </Flex>
                                    )}

                                    {/* Special Note for Binance Deposits/Withdrawals */}
                                    {isEnabled && (connector.connector_type === 'binance-deposits' || connector.connector_type === 'binance-withdrawals') && (
                                        <Flex gap={2} mt={1} pl={6} align="start">
                                            <Text fontSize="2xs" color="orange.600" fontStyle="italic">
                                                Note: Default start date is 90 days ago. If start date is set, end date is start date + 90 days.
                                            </Text>
                                        </Flex>
                                    )}

                                    {/* Special Note for MEXC API Connectors (Transactions, Deposits, Withdrawals) */}
                                    {isEnabled && !connector.is_file_connector && (connector.connector_type === 'mexc-transactions' || connector.connector_type === 'mexc-deposits' || connector.connector_type === 'mexc-withdrawals') && (
                                        <Flex gap={2} mt={1} pl={6} align="start">
                                            <Text fontSize="2xs" color="orange.600" fontStyle="italic">
                                                ⚠️ Note: MEXC API cannot retrieve data older than 90 days.
                                            </Text>
                                        </Flex>
                                    )}

                                    {/* Row 3: Symbols filter (for trade connectors) */}
                                    {supportsSymbols && isEnabled && (
                                        <Flex align="center" gap={2} mt={2} pl={6}>
                                            <Text fontSize="xs" color="gray.500" minW="50px">Symbols:</Text>
                                            <CommaSeparatedInput
                                                value={currentSymbols}
                                                onChange={(symbols) => onSymbolsChange(connector.connector_id, symbols)}
                                                placeholder="All symbols (e.g., BTC/USDT, ETH/USDT)"
                                                disabled={disabled}
                                            />
                                            {hasSymbolsOverride && (
                                                <IconButton
                                                    aria-label="Clear symbols filter"
                                                    size="xs"
                                                    variant="ghost"
                                                    onClick={() => onSymbolsChange(connector.connector_id, null)}
                                                    title="Clear filter (use all symbols)"
                                                    disabled={disabled}
                                                >
                                                    <LuX size={12} />
                                                </IconButton>
                                            )}
                                            {hasSymbolsOverride && (
                                                <Badge colorPalette="blue" size="xs" variant="subtle">filtered</Badge>
                                            )}
                                        </Flex>
                                    )}

                                    {/* Row 4: Currencies filter (for deposit/withdrawal connectors) */}
                                    {supportsCurrencies && isEnabled && (
                                        <Flex align="center" gap={2} mt={2} pl={6}>
                                            <Text fontSize="xs" color="gray.500" minW="50px">Currencies:</Text>
                                            <CommaSeparatedInput
                                                value={currentCurrencies}
                                                onChange={(currencies) => onCurrenciesChange(connector.connector_id, currencies)}
                                                placeholder="All currencies (e.g., BTC, ETH, USDT)"
                                                disabled={disabled}
                                                uppercase
                                            />
                                            {hasCurrenciesOverride && (
                                                <IconButton
                                                    aria-label="Clear currencies filter"
                                                    size="xs"
                                                    variant="ghost"
                                                    onClick={() => onCurrenciesChange(connector.connector_id, null)}
                                                    title="Clear filter (use all currencies)"
                                                    disabled={disabled}
                                                >
                                                    <LuX size={12} />
                                                </IconButton>
                                            )}
                                            {hasCurrenciesOverride && (
                                                <Badge colorPalette="blue" size="xs" variant="subtle">filtered</Badge>
                                            )}
                                        </Flex>
                                    )}

                                    {/* Row 5: File Upload (for file connectors) */}
                                    {connector.is_file_connector && isEnabled && (
                                        <ConnectorFileUpload
                                            connectorId={connector.connector_id}
                                            connectorType={connector.connector_type}
                                            disabled={disabled}
                                            onUploadComplete={() => onFileUploadComplete(connector.connector_id)}
                                        />
                                    )}

                                    {/* Row 6: Job snippet - only show if enabled */}
                                    {isEnabled && (
                                        <Box mt={2}>
                                            <ConnectorJobSnippet
                                                connector={connector}
                                                onClick={() => onJobSnippetClick(connector)}
                                            />
                                        </Box>
                                    )}

                                    {/* Row 7: Last synced transaction - compact inline */}
                                    {isEnabled && connector.last_synced_transaction && (
                                        <HStack mt={1} gap={1} fontSize="2xs" flexWrap="wrap">
                                            <Text color="gray.500">Last:</Text>
                                            <Badge size="xs" colorPalette="green" variant="subtle">
                                                {new Date(connector.last_synced_transaction.datetime).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                {' '}
                                                {new Date(connector.last_synced_transaction.datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </Badge>
                                            <Text color="gray.700" fontFamily="mono" truncate flex="1" minW={0}>
                                                {connector.last_synced_transaction.type.toUpperCase()}
                                                {' '}
                                                {connector.last_synced_transaction.qty?.toFixed(4) || ''}
                                                {' '}
                                                {connector.last_synced_transaction.asset}
                                            </Text>
                                        </HStack>
                                    )}
                                </Box>
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

    // Track collapsed state for disabled accounts (horizontal collapse)
    const [collapsedAccounts, setCollapsedAccounts] = useState<Map<number, boolean>>(new Map());

    // Job detail drawer state
    const [selectedJobConnector, setSelectedJobConnector] = useState<EnabledConnector | null>(null);
    const [jobDrawerOpen, setJobDrawerOpen] = useState(false);

    // Balance drawer state
    const [balanceDrawerOpen, setBalanceDrawerOpen] = useState(false);
    const [balanceMode, setBalanceMode] = useState<'global' | 'account'>('global');
    const [balanceAccountId, setBalanceAccountId] = useState<number | undefined>();
    const [balanceTitle, setBalanceTitle] = useState<string | undefined>();

    const handleBalanceClick = useCallback((accountId: number) => {
        const account = accounts.find(a => a.id === accountId);
        setBalanceMode('account');
        setBalanceAccountId(accountId);
        setBalanceTitle(account ? `${account.name} Balance` : 'Account Balance');
        setBalanceDrawerOpen(true);
    }, [accounts]);

    const handleGlobalBalanceClick = useCallback(() => {
        setBalanceMode('global');
        setBalanceAccountId(undefined);
        setBalanceTitle('Global Balance');
        setBalanceDrawerOpen(true);
    }, []);

    // Initialize collapsed state for disabled accounts (all disabled accounts collapsed by default)
    useEffect(() => {
        // Only initialize if collapsedAccounts is empty (first load)
        if (collapsedAccounts.size > 0) return;

        const initialCollapsed = new Map<number, boolean>();
        accounts.forEach(account => {
            const accountConnectors = connectors.filter(c => c.account_id === account.id);
            // Check if any connector is enabled at base level (before overrides)
            const enabledCount = accountConnectors.filter(c => c.enabled && (c.account_enabled ?? true)).length;
            if (enabledCount === 0) {
                initialCollapsed.set(account.id, true);
            }
        });
        setCollapsedAccounts(initialCollapsed);
    }, [accounts, connectors]);

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

    // Group accounts by type
    const accountsByType = useMemo(() => {
        const exchanges = accounts.filter(a => a.account_type === 'cex');
        const wallets = accounts.filter(a => a.account_type === 'wallet');
        const brokers = accounts.filter(a => a.account_type === 'broker');
        return { exchanges, wallets, brokers };
    }, [accounts]);

    // Track collapsed state for account type sections
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

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

        // Add explicit connector overrides (including since_datetime, symbols, currencies)
        for (const [connectorId, override] of overrides) {
            if (override.enabled !== undefined || override.test_mode !== undefined ||
                override.since_datetime !== undefined || override.symbols !== undefined ||
                override.currencies !== undefined) {
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
        // Check if this change makes all connectors in the account disabled
        const connector = connectors.find(c => c.connector_id === connectorId);
        const accountId = connector?.account_id;
        const accountConnectors = accountId ? (connectorsByAccount.get(accountId) || []) : [];

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

            // Compute if all connectors will be disabled after this change
            if (accountId) {
                const allDisabled = accountConnectors.every(c => {
                    if (c.connector_id === connectorId) {
                        // For the connector being changed, use the new enabled value
                        return !enabled;
                    } else {
                        // For other connectors, check their effective enabled state with the new overrides
                        const override = next.get(c.connector_id);
                        const accountOverride = accountOverrides.get(c.account_id);

                        if (override?.enabled !== undefined) {
                            return !override.enabled;
                        }
                        if (accountOverride !== undefined) {
                            return !accountOverride;
                        }
                        return !(c.enabled && (c.account_enabled ?? true));
                    }
                });

                // Update collapsed state based on whether all are disabled
                setCollapsedAccounts(prevCollapsed => {
                    const nextCollapsed = new Map(prevCollapsed);
                    if (allDisabled) {
                        nextCollapsed.set(accountId, true);
                    } else if (nextCollapsed.get(accountId)) {
                        // Only auto-expand if it was collapsed
                        nextCollapsed.set(accountId, false);
                    }
                    return nextCollapsed;
                });
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

    const handleSinceChange = (connectorId: number, since: string | null, defaultSince: string | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            // If value matches default, remove the override
            if (since === defaultSince) {
                const { since_datetime: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, since_datetime: since });
            }
            return next;
        });
    };

    const handleSinceReset = (connectorId: number) => {
        // Remove the since_datetime override to use default
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId);
            if (existing) {
                const { since_datetime: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            }
            return next;
        });
    };

    const handleSinceClear = (connectorId: number) => {
        // Explicitly set since_datetime to null for full sync
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };
            next.set(connectorId, { ...existing, since_datetime: null });
            return next;
        });
    };

    const handleSymbolsChange = (connectorId: number, symbols: string[] | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (symbols === null) {
                // Remove the symbols override
                const { symbols: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, symbols });
            }
            return next;
        });
    };

    const handleCurrenciesChange = (connectorId: number, currencies: string[] | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (currencies === null) {
                // Remove the currencies override
                const { currencies: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, currencies });
            }
            return next;
        });
    };

    // Handle file upload completion - refresh connector data
    const handleFileUploadComplete = useCallback((connectorId: number) => {
        // Refresh connectors to get updated import history
        fetchConnectors();
    }, [fetchConnectors]);

    // Handle job snippet click - open drawer for specific connector's job
    const handleJobSnippetClick = (connector: EnabledConnector) => {
        setSelectedJobConnector(connector);
        setJobDrawerOpen(true);
    };

    // Toggle horizontal collapse for disabled account
    const toggleAccountCollapse = (accountId: number) => {
        setCollapsedAccounts(prev => {
            const next = new Map(prev);
            next.set(accountId, !prev.get(accountId));
            return next;
        });
    };

    const handleAccountToggle = (accountId: number, enabled: boolean) => {
        const accountConnectors = connectorsByAccount.get(accountId) || [];

        // Set individual connector overrides for each connector in this account
        // This ensures ALL connectors are set to the desired state regardless of their defaults
        setOverrides(prev => {
            const next = new Map(prev);
            for (const c of accountConnectors) {
                const defaultEnabled = c.enabled && (c.account_enabled ?? true);
                const existing = next.get(c.connector_id) || { connector_id: c.connector_id };

                if (enabled === defaultEnabled) {
                    // Matches default — remove the enabled override but keep other overrides (test_mode, since, etc.)
                    const { enabled: _, ...rest } = existing;
                    if (Object.keys(rest).length <= 1) {
                        next.delete(c.connector_id);
                    } else {
                        next.set(c.connector_id, rest as ConnectorOverride);
                    }
                } else {
                    next.set(c.connector_id, { ...existing, enabled });
                }
            }
            return next;
        });

        // Clear any account-level override since we're using per-connector overrides
        setAccountOverrides(prev => {
            const next = new Map(prev);
            next.delete(accountId);
            return next;
        });

        // Automatically collapse/expand account based on enabled state
        setCollapsedAccounts(prev => {
            const next = new Map(prev);
            if (!enabled) {
                next.set(accountId, true);
            } else {
                next.set(accountId, false);
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

    const refreshConfiguration = () => {
        // Refresh connectors and accounts from backend
        fetchConnectors();
        // Clear overrides
        resetOverrides();
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
                            <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="blue"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    refreshConfiguration();
                                }}
                                disabled={disabled || loading}
                            >
                                🔄 Refresh
                            </Button>
                            <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="green"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGlobalBalanceClick();
                                }}
                            >
                                <FiDollarSign size={12} />
                                Balance
                            </Button>
                        </Flex>

                        {/* Account Type Sections */}
                        {[{ type: 'cex', label: '🏦 Exchanges', accounts: accountsByType.exchanges, colorScheme: 'purple' },
                        { type: 'wallet', label: '💼 Wallets', accounts: accountsByType.wallets, colorScheme: 'teal' },
                        { type: 'broker', label: '📊 Brokers', accounts: accountsByType.brokers, colorScheme: 'blue' }]
                            .filter(section => section.accounts.length > 0)
                            .map(section => {
                                const sectionConnectors = section.accounts.flatMap(a => connectorsByAccount.get(a.id) || []);
                                const sectionEnabledCount = sectionConnectors.filter(c => getEffectiveEnabled(c)).length;
                                const isCollapsed = collapsedSections[section.type] ?? false;

                                // Check if all connectors in section are enabled
                                const allEnabled = sectionConnectors.length > 0 && sectionConnectors.every(c => getEffectiveEnabled(c));

                                const toggleSectionAll = (enabled: boolean) => {
                                    section.accounts.forEach(account => {
                                        handleAccountToggle(account.id, enabled);
                                    });
                                };

                                return (
                                    <Box key={section.type} mb={4}>
                                        {/* Section Header */}
                                        <Flex
                                            align="center"
                                            justify="space-between"
                                            py={2}
                                            px={2}
                                            bg={`${section.colorScheme}.50`}
                                            borderRadius="md"
                                            mb={2}
                                            cursor="pointer"
                                            onClick={() => setCollapsedSections(prev => ({ ...prev, [section.type]: !isCollapsed }))}
                                            _hover={{ bg: `${section.colorScheme}.100` }}
                                        >
                                            <Flex align="center" gap={2}>
                                                <Text color="gray.400" fontSize="xs">{isCollapsed ? '▶' : '▼'}</Text>
                                                <Text fontWeight="medium" fontSize="sm" color="gray.700">
                                                    {section.label}
                                                </Text>
                                                <Badge colorPalette="gray" size="xs" variant="subtle">
                                                    {section.accounts.length} {section.accounts.length === 1 ? 'account' : 'accounts'}
                                                </Badge>
                                                <Badge colorPalette="blue" size="xs" variant="subtle">
                                                    {sectionEnabledCount}/{sectionConnectors.length}
                                                </Badge>
                                            </Flex>
                                            <Flex align="center" gap={2} onClick={(e) => e.stopPropagation()}>
                                                <Tooltip.Root
                                                    positioning={{ placement: "top" }}
                                                    openDelay={300}
                                                >
                                                    <Tooltip.Trigger asChild>
                                                        <Box display="inline-flex">
                                                            <Checkbox.Root
                                                                checked={allEnabled}
                                                                indeterminate={sectionEnabledCount > 0 && !allEnabled}
                                                                disabled={disabled}
                                                                onCheckedChange={(details) => {
                                                                    // Determine if we're in mixed state
                                                                    const isMixed = sectionEnabledCount > 0 && !allEnabled;
                                                                    // When in mixed state, always enable all
                                                                    // When all enabled, disable all
                                                                    // When none enabled, enable all
                                                                    toggleSectionAll(isMixed ? true : !!details.checked);
                                                                }}
                                                                size="sm"
                                                            >
                                                                <Checkbox.HiddenInput />
                                                                <Checkbox.Control>
                                                                    <Checkbox.Indicator />
                                                                </Checkbox.Control>
                                                            </Checkbox.Root>
                                                        </Box>
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Positioner>
                                                        <Tooltip.Content>
                                                            {(() => {
                                                                if (allEnabled) {
                                                                    return `Click to disable all ${section.label} connectors`;
                                                                }
                                                                if (sectionEnabledCount > 0) {
                                                                    return `${sectionEnabledCount} of ${sectionConnectors.length} enabled - Click to enable all`;
                                                                }
                                                                return `Click to enable all ${section.label} connectors`;
                                                            })()}
                                                        </Tooltip.Content>
                                                    </Tooltip.Positioner>
                                                </Tooltip.Root>
                                            </Flex>
                                        </Flex>

                                        {/* Section Content - Account Cards */}
                                        <Collapsible.Root open={!isCollapsed}>
                                            <Collapsible.Content>
                                                <Flex
                                                    wrap="wrap"
                                                    gap={3}
                                                    pl={2}
                                                >
                                                    {section.accounts.map((account) => {
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
                                                                onSinceChange={handleSinceChange}
                                                                onSinceReset={handleSinceReset}
                                                                onSinceClear={handleSinceClear}
                                                                onSymbolsChange={handleSymbolsChange}
                                                                onCurrenciesChange={handleCurrenciesChange}
                                                                onFileUploadComplete={handleFileUploadComplete}
                                                                onJobSnippetClick={handleJobSnippetClick}
                                                                onBalanceClick={handleBalanceClick}
                                                                isCollapsed={collapsedAccounts.get(account.id) ?? false}
                                                                onToggleCollapse={() => toggleAccountCollapse(account.id)}
                                                                disabled={disabled}
                                                            />
                                                        );
                                                    })}
                                                </Flex>
                                            </Collapsible.Content>
                                        </Collapsible.Root>
                                    </Box>
                                );
                            })}
                    </Box>
                </Collapsible.Content>
            </Collapsible.Root>

            {/* Job Detail Drawer */}
            {selectedJobConnector && (
                <JobDetailDrawer
                    jobId={null}  // Will show the latest job
                    open={jobDrawerOpen}
                    onClose={() => {
                        setJobDrawerOpen(false);
                        setSelectedJobConnector(null);
                    }}
                />
            )}

            {/* Balance Drawer */}
            <BalanceDrawer
                isOpen={balanceDrawerOpen}
                onClose={() => setBalanceDrawerOpen(false)}
                mode={balanceMode}
                accountId={balanceAccountId}
                title={balanceTitle}
            />
        </Box>
    );
};
