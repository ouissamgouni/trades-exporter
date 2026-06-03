import React, { useState, useEffect } from 'react';
import {
    Badge,
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    NativeSelect,
    Portal,
    Text,
    Textarea,
} from '@chakra-ui/react';

import { Account, AccountConnector, ConnectorTypeInfo, API_URL } from '../types';
import { ColorPaletteField } from './ColorPaletteField';
import { getNextAvailableEntityColor } from '../hooks/useEntityColors';

interface ConnectorFormDialogProps {
    isOpen: boolean;
    onClose: () => void;
    account: Account;
    connector?: AccountConnector | null;
    connectorTypes: ConnectorTypeInfo[];
    existingConnectorTypes: string[];
    /** Colors already assigned to sibling connectors (for dedup hints) */
    usedColors?: string[];
}

const ConnectorFormDialog: React.FC<ConnectorFormDialogProps> = ({
    isOpen,
    onClose,
    account,
    connector,
    connectorTypes,
    existingConnectorTypes,
    usedColors = [],
}) => {
    const [formData, setFormData] = useState({
        connector_type: '',
        enabled: true,
        config: {} as Record<string, any>,
        credentials_ref: '',
        sync_priority: 100,
        color: null as string | null,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [defaultFile, setDefaultFile] = useState<File | null>(null);
    const [defaultFileName, setDefaultFileName] = useState<string | null>(null);
    const [uploadingDefault, setUploadingDefault] = useState(false);

    // Test fixture state
    const [testFixtureFile, setTestFixtureFile] = useState<File | null>(null);
    const [testFixtureStatus, setTestFixtureStatus] = useState<{
        test_mode: boolean;
        has_fixture: boolean;
        item_count: number | null;
    } | null>(null);
    const [uploadingFixture, setUploadingFixture] = useState(false);

    // Track previous isOpen state to detect when dialog opens
    const prevIsOpenRef = React.useRef(isOpen);

    // Get available types for new connectors (not already configured)
    const availableTypes = connector
        ? connectorTypes // If editing, show all types
        : connectorTypes.filter(t => !existingConnectorTypes.includes(t.type));

    const selectedTypeInfo = connectorTypes.find(t => t.type === formData.connector_type);

    useEffect(() => {
        // Only reset form when dialog opens (not on every render)
        const dialogJustOpened = isOpen && !prevIsOpenRef.current;
        prevIsOpenRef.current = isOpen;

        if (!dialogJustOpened) {
            return;
        }

        if (connector) {
            setFormData({
                connector_type: connector.connector_type,
                enabled: connector.enabled,
                config: connector.config || {},
                credentials_ref: connector.credentials_ref || '',
                sync_priority: connector.sync_priority,
                color: connector.color || null,
            });
            // Load default file name if set
            setDefaultFileName(connector.config?.default_file_name || null);
            setDefaultFile(null);

            // Load test fixture status
            setTestFixtureFile(null);
            if (connector.id) {
                fetch(`${API_URL}/fixtures/connectors/${connector.id}/test-fixture`)
                    .then(r => r.ok ? r.json() : null)
                    .then(data => setTestFixtureStatus(data))
                    .catch(() => setTestFixtureStatus(null));
            }
        } else {
            // Reset form for creating new connector
            const firstAvailable = connectorTypes.find(t => !existingConnectorTypes.includes(t.type));

            // Auto-detect chain from account address for wallet accounts
            const isWalletAccount = account.account_type === 'wallet';
            const accountAddress = account.address_or_identifier;
            const detectedChain = isWalletAccount ? detectChainFromAddress(accountAddress) : null;

            const initialConfig: Record<string, any> = {};
            if (detectedChain && firstAvailable?.supported_chains?.includes(detectedChain)) {
                initialConfig.chain = detectedChain;
            }

            setFormData({
                connector_type: firstAvailable?.type || '',
                enabled: true,
                config: initialConfig,
                credentials_ref: '',
                sync_priority: 100,
                color: getNextAvailableEntityColor(usedColors),
            });
            setTestFixtureStatus(null);
            setTestFixtureFile(null);
        }
        setError('');
    }, [isOpen, connector, connectorTypes, existingConnectorTypes, account]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const configToSave = { ...formData.config };

            // Remove address from config if it's inherited from account
            // (Backend will auto-inherit it)
            const isWalletAccount = account.account_type === 'wallet';
            const shouldInheritAddress = isWalletAccount && account.address_or_identifier;
            if (shouldInheritAddress && configToSave.address === account.address_or_identifier) {
                delete configToSave.address;
            }

            const payload = {
                connector_type: formData.connector_type,
                enabled: formData.enabled,
                config: configToSave,
                credentials_ref: formData.credentials_ref || null,
                sync_priority: formData.sync_priority,
                color: formData.color || null,
            };

            const url = connector
                ? `${API_URL}/accounts/${account.id}/connectors/${connector.connector_type}`
                : `${API_URL}/accounts/${account.id}/connectors/`;

            const method = connector ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to save connector');
            }

            const savedConnector = await response.json();

            // Upload default file for file connectors if a file was selected
            if (defaultFile && savedConnector.id) {
                setUploadingDefault(true);
                const fileFormData = new FormData();
                fileFormData.append('file', defaultFile);

                const uploadResponse = await fetch(
                    `${API_URL}/connectors/${savedConnector.id}/upload-file/confirm?as_default=true`,
                    {
                        method: 'POST',
                        body: fileFormData,
                    }
                );

                if (!uploadResponse.ok) {
                    const errorData = await uploadResponse.json();
                    throw new Error(errorData.detail || 'Failed to upload default file');
                }
            }

            onClose();
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
            setUploadingDefault(false);
        }
    };

    const updateConfig = (key: string, value: any) => {
        setFormData(prev => ({
            ...prev,
            config: { ...prev.config, [key]: value },
        }));
    };

    const handleUploadFixture = async () => {
        if (!testFixtureFile || !connector?.id) return;
        setUploadingFixture(true);
        setError('');
        try {
            const fd = new FormData();
            fd.append('file', testFixtureFile);
            const response = await fetch(
                `${API_URL}/fixtures/connectors/${connector.id}/test-fixture`,
                { method: 'POST', body: fd }
            );
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Failed to upload fixture');
            }
            const result = await response.json();
            setTestFixtureStatus({ test_mode: true, has_fixture: true, item_count: result.item_count });
            setTestFixtureFile(null);
        } catch (err: any) {
            setError(err.message || 'Failed to upload fixture');
        } finally {
            setUploadingFixture(false);
        }
    };

    const handleRemoveFixture = async () => {
        if (!connector?.id) return;
        setUploadingFixture(true);
        setError('');
        try {
            const response = await fetch(
                `${API_URL}/fixtures/connectors/${connector.id}/test-fixture`,
                { method: 'DELETE' }
            );
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Failed to remove fixture');
            }
            setTestFixtureStatus({ test_mode: false, has_fixture: false, item_count: null });
            setTestFixtureFile(null);
        } catch (err: any) {
            setError(err.message || 'Failed to remove fixture');
        } finally {
            setUploadingFixture(false);
        }
    };

    // Detect blockchain chain from address format
    const detectChainFromAddress = (address?: string): string | null => {
        if (!address) return null;

        // EVM chains (Ethereum, Base, etc.) start with 0x
        if (address.startsWith('0x')) {
            // Default to ethereum for EVM addresses
            // Could be any EVM chain, but we'll let user choose if needed
            return 'ethereum';
        }

        // XRP addresses start with 'r'
        if (address.startsWith('r') && address.length >= 25 && address.length <= 35) {
            return 'xrp';
        }

        // Solana addresses are base58 encoded, typically 32-44 characters
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            return 'solana';
        }

        return null;
    };

    const renderConfigFields = () => {
        if (!selectedTypeInfo) return null;

        const fields = [];

        // Check if this is a wallet account with an address
        const isWalletAccount = account.account_type === 'wallet';
        const accountAddress = account.address_or_identifier;
        const detectedChain = isWalletAccount ? detectChainFromAddress(accountAddress) : null;
        const shouldInheritAddress = !!(isWalletAccount && accountAddress);

        // Chain selector for on-chain connectors
        if (selectedTypeInfo.supported_chains?.length) {
            // Priority: 1) user selection in form, 2) saved connector config (immediate prop),
            // 3) auto-detected from address, 4) empty
            const chainValue = formData.config.chain || connector?.config?.chain || detectedChain || '';
            // Only lock chain for unambiguous address formats (XRP, Solana)
            // EVM addresses (0x) are valid on multiple chains, so pre-select but don't lock
            const isChainInherited = !!(isWalletAccount && detectedChain && detectedChain !== 'ethereum');

            fields.push(
                <Box key="chain">
                    <Text fontWeight="medium" mb={1}>
                        Chain <Text as="span" color="red.500">*</Text>
                    </Text>
                    <NativeSelect.Root disabled={isChainInherited}>
                        <NativeSelect.Field
                            value={chainValue}
                            onChange={(e) => updateConfig('chain', e.target.value)}
                        >
                            <option value="">Select chain...</option>
                            {selectedTypeInfo.supported_chains.map(chain => (
                                <option key={chain} value={chain}>
                                    {chain.toUpperCase()}
                                </option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                    {isChainInherited && (
                        <Text fontSize="xs" color="gray.500" mt={1}>
                            Detected from account address
                        </Text>
                    )}
                    {isWalletAccount && detectedChain === 'ethereum' && (
                        <Text fontSize="xs" color="gray.500" mt={1}>
                            Pre-selected from address (EVM-compatible)
                        </Text>
                    )}
                </Box>
            );
        }

        // Address field for on-chain connectors
        if (selectedTypeInfo.required_config.includes('address') ||
            selectedTypeInfo.optional_config.includes('address')) {
            const isRequired = selectedTypeInfo.required_config.includes('address');
            const addressValue = shouldInheritAddress ? accountAddress : (formData.config.address || '');

            fields.push(
                <Box key="address">
                    <Text fontWeight="medium" mb={1}>
                        Wallet Address {isRequired && <Text as="span" color="red.500">*</Text>}
                    </Text>
                    <Input
                        value={addressValue}
                        onChange={(e) => updateConfig('address', e.target.value)}
                        placeholder="0x..."
                        required={isRequired}
                        disabled={shouldInheritAddress}
                    />
                    {shouldInheritAddress && (
                        <Text fontSize="xs" color="gray.500" mt={1}>
                            Inherited from account
                        </Text>
                    )}
                </Box>
            );
        }

        // Symbols field for CEX connectors
        if (selectedTypeInfo.required_config.includes('symbols') ||
            selectedTypeInfo.optional_config.includes('symbols')) {
            const isRequired = selectedTypeInfo.required_config.includes('symbols');
            fields.push(
                <Box key="symbols">
                    <Text fontWeight="medium" mb={1}>
                        Trading Pairs {isRequired && <Text as="span" color="red.500">*</Text>}
                    </Text>
                    <Textarea
                        value={(formData.config.symbols || []).join(', ')}
                        onChange={(e) => {
                            const symbols = e.target.value
                                .split(',')
                                .map(s => s.trim())
                                .filter(s => s.length > 0);
                            updateConfig('symbols', symbols);
                        }}
                        placeholder="BTCEUR, ETHEUR, SOLUSDT"
                        rows={2}
                    />
                    <Text fontSize="sm" color="gray.500" mt={1}>
                        Comma-separated trading pairs
                    </Text>
                </Box>
            );
        }

        // Wallet address for connectors that need an explicit on-chain address
        // (e.g. Hyperliquid which queries by wallet address)
        if (selectedTypeInfo.required_config.includes('wallet_address') ||
            selectedTypeInfo.optional_config.includes('wallet_address')) {
            const isRequired = selectedTypeInfo.required_config.includes('wallet_address');
            // For wallet accounts, pre-fill from account address
            const inheritAddress = isWalletAccount && accountAddress;
            const walletValue = inheritAddress
                ? accountAddress
                : (formData.config.wallet_address || '');

            fields.push(
                <Box key="wallet_address">
                    <Text fontWeight="medium" mb={1}>
                        Wallet Address {isRequired && <Text as="span" color="red.500">*</Text>}
                    </Text>
                    <Input
                        value={walletValue}
                        onChange={(e) => updateConfig('wallet_address', e.target.value)}
                        placeholder="0x..."
                        required={isRequired}
                        disabled={!!inheritAddress}
                    />
                    {inheritAddress && (
                        <Text fontSize="xs" color="gray.500" mt={1}>
                            Inherited from account
                        </Text>
                    )}
                </Box>
            );
        }

        // Start datetime for configuring default sync start
        if (selectedTypeInfo.optional_config.includes('start_datetime')) {
            fields.push(
                <Box key="start_datetime">
                    <Text fontWeight="medium" mb={1}>Start Date</Text>
                    <Input
                        type="datetime-local"
                        value={formData.config.start_datetime || ''}
                        onChange={(e) => updateConfig('start_datetime', e.target.value || null)}
                    />
                    <Text fontSize="xs" color="gray.500" mt={1}>
                        Default start date for incremental sync
                    </Text>
                </Box>
            );
        }

        // Timezone selector for file connectors whose CSV timestamps are in a local timezone
        if (selectedTypeInfo.optional_config.includes('timezone')) {
            // Default to browser timezone on create
            const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const currentValue = formData.config.timezone ?? browserTz;

            // Initialize config with browser timezone if not set yet
            if (formData.config.timezone === undefined) {
                // Use a microtask to avoid updating state during render
                Promise.resolve().then(() => updateConfig('timezone', browserTz));
            }

            fields.push(
                <Box key="timezone">
                    <Text fontWeight="medium" mb={1}>
                        File Timezone
                    </Text>
                    <NativeSelect.Root>
                        <NativeSelect.Field
                            value={currentValue}
                            onChange={(e) => updateConfig('timezone', e.target.value)}
                        >
                            {(() => {
                                // Build a curated list of common IANA timezones
                                const commonTimezones = [
                                    'UTC',
                                    'Europe/London',
                                    'Europe/Paris',
                                    'Europe/Berlin',
                                    'Europe/Amsterdam',
                                    'Europe/Brussels',
                                    'Europe/Zurich',
                                    'Europe/Rome',
                                    'Europe/Madrid',
                                    'Europe/Lisbon',
                                    'Europe/Vienna',
                                    'Europe/Warsaw',
                                    'Europe/Prague',
                                    'Europe/Budapest',
                                    'Europe/Bucharest',
                                    'Europe/Athens',
                                    'Europe/Helsinki',
                                    'Europe/Stockholm',
                                    'Europe/Oslo',
                                    'Europe/Copenhagen',
                                    'Europe/Dublin',
                                    'Europe/Istanbul',
                                    'Europe/Moscow',
                                    'Asia/Dubai',
                                    'Asia/Kolkata',
                                    'Asia/Bangkok',
                                    'Asia/Singapore',
                                    'Asia/Hong_Kong',
                                    'Asia/Shanghai',
                                    'Asia/Seoul',
                                    'Asia/Tokyo',
                                    'Australia/Sydney',
                                    'Australia/Melbourne',
                                    'Pacific/Auckland',
                                    'America/New_York',
                                    'America/Chicago',
                                    'America/Denver',
                                    'America/Los_Angeles',
                                    'America/Toronto',
                                    'America/Sao_Paulo',
                                    'America/Argentina/Buenos_Aires',
                                ];
                                // Ensure browser timezone is in the list
                                const allTimezones = commonTimezones.includes(browserTz)
                                    ? commonTimezones
                                    : [browserTz, ...commonTimezones];
                                return allTimezones.map(tz => (
                                    <option key={tz} value={tz}>
                                        {tz.replace(/_/g, ' ')}{tz === browserTz ? ' (detected)' : ''}
                                    </option>
                                ));
                            })()}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                    <Text fontSize="xs" color="gray.500" mt={1}>
                        Timezone of timestamps in the exported CSV file (usually your browser timezone when you exported from OKX)
                    </Text>
                </Box>
            );
        }

        return fields;
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>
                                {connector ? 'Edit Connector' : 'Add Connector'}
                            </Dialog.Title>
                        </Dialog.Header>

                        <form onSubmit={handleSubmit}>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    {error && (
                                        <Box p={3} bg="red.50" borderRadius="md">
                                            <Text color="red.600" fontSize="sm">{error}</Text>
                                        </Box>
                                    )}

                                    {/* Connector Type */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Connector Type <Text as="span" color="red.500">*</Text>
                                        </Text>
                                        <NativeSelect.Root disabled={!!connector}>
                                            <NativeSelect.Field
                                                value={formData.connector_type}
                                                onChange={(e) => {
                                                    setFormData(prev => ({
                                                        ...prev,
                                                        connector_type: e.target.value,
                                                        config: {}, // Reset config when type changes
                                                    }));
                                                }}
                                            >
                                                {!connector && <option value="">Select connector...</option>}
                                                {(connector ? connectorTypes : availableTypes).map(type => (
                                                    <option key={type.type} value={type.type}>
                                                        {type.display_name} ({type.category})
                                                    </option>
                                                ))}
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>

                                    {/* Dynamic Config Fields */}
                                    {renderConfigFields()}

                                    {/* Credentials Reference */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>API Key Reference</Text>
                                        <Input
                                            value={formData.credentials_ref}
                                            onChange={(e) =>
                                                setFormData(prev => ({ ...prev, credentials_ref: e.target.value }))
                                            }
                                            placeholder="env:BINANCE_API_KEY"
                                        />
                                        <Text fontSize="sm" color="gray.500" mt={1}>
                                            Use env:VAR_NAME to reference environment variable
                                        </Text>
                                    </Box>

                                    {/* Sync Priority */}
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Sync Priority</Text>
                                        <Input
                                            type="number"
                                            value={formData.sync_priority}
                                            onChange={(e) =>
                                                setFormData(prev => ({
                                                    ...prev,
                                                    sync_priority: parseInt(e.target.value) || 100,
                                                }))
                                            }
                                            min={1}
                                            max={1000}
                                        />
                                        <Text fontSize="sm" color="gray.500" mt={1}>
                                            Lower number = higher priority (synced first)
                                        </Text>
                                    </Box>

                                    {/* Color */}
                                    <ColorPaletteField
                                        value={formData.color}
                                        onChange={(color) => setFormData(prev => ({ ...prev, color }))}
                                        usedColors={usedColors}
                                    />

                                    {/* Default File for file connectors */}
                                    {selectedTypeInfo?.is_file_connector && (
                                        <Box
                                            p={4}
                                            borderWidth="1px"
                                            borderRadius="md"
                                            borderColor={defaultFile || defaultFileName ? 'blue.200' : 'gray.200'}
                                            bg={defaultFile || defaultFileName ? 'blue.50' : 'transparent'}
                                        >
                                            <Text fontWeight="medium" mb={2}>📁 Default File</Text>
                                            <Text fontSize="sm" color="gray.500" mb={3}>
                                                Set a default file to auto-use when syncing this connector.
                                            </Text>
                                            {defaultFileName && !defaultFile && (
                                                <Flex align="center" gap={2} mb={2}>
                                                    <Text fontSize="sm" color="blue.600">
                                                        Current: {defaultFileName}
                                                    </Text>
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        colorPalette="red"
                                                        onClick={() => setDefaultFileName(null)}
                                                    >
                                                        Remove
                                                    </Button>
                                                </Flex>
                                            )}
                                            <Input
                                                type="file"
                                                accept={(selectedTypeInfo.type.includes('okx') || selectedTypeInfo.type.includes('degiro')) ? '.csv' : '.xlsx,.xls'}
                                                onChange={(e) => {
                                                    const file = e.target.files?.[0] || null;
                                                    setDefaultFile(file);
                                                }}
                                                disabled={uploadingDefault}
                                                size="sm"
                                            />
                                            {defaultFile && (
                                                <Text fontSize="xs" color="blue.600" mt={1}>
                                                    Will upload: {defaultFile.name}
                                                </Text>
                                            )}
                                            {!connector && (
                                                <Text fontSize="xs" color="gray.500" mt={1}>
                                                    File will be uploaded after the connector is created.
                                                </Text>
                                            )}
                                        </Box>
                                    )}

                                    {/* Test Fixture (edit mode only) */}
                                    {connector && (
                                        <Box
                                            p={4}
                                            borderWidth="1px"
                                            borderRadius="md"
                                            borderColor={testFixtureStatus?.test_mode ? 'orange.300' : 'gray.200'}
                                            bg={testFixtureStatus?.test_mode ? 'orange.50' : 'transparent'}
                                        >
                                            <Text fontWeight="medium" mb={2}>🧪 Test Fixture</Text>
                                            <Text fontSize="sm" color="gray.500" mb={3}>
                                                Upload a JSON fixture to use during sync instead of the real API.
                                            </Text>
                                            {testFixtureStatus?.has_fixture && (
                                                <Flex align="center" gap={2} mb={2}>
                                                    <Badge colorPalette="orange" size="sm">
                                                        Test Mode Active — {testFixtureStatus.item_count} items
                                                    </Badge>
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        colorPalette="red"
                                                        onClick={handleRemoveFixture}
                                                        disabled={uploadingFixture}
                                                    >
                                                        Remove
                                                    </Button>
                                                </Flex>
                                            )}
                                            {!testFixtureStatus?.has_fixture && (
                                                <>
                                                    <Input
                                                        type="file"
                                                        accept=".json"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0] || null;
                                                            setTestFixtureFile(file);
                                                        }}
                                                        disabled={uploadingFixture}
                                                        size="sm"
                                                    />
                                                    {testFixtureFile && (
                                                        <Flex align="center" gap={2} mt={2}>
                                                            <Text fontSize="xs" color="orange.600">
                                                                Selected: {testFixtureFile.name}
                                                            </Text>
                                                            <Button
                                                                size="xs"
                                                                colorPalette="orange"
                                                                onClick={handleUploadFixture}
                                                                loading={uploadingFixture}
                                                            >
                                                                Upload
                                                            </Button>
                                                        </Flex>
                                                    )}
                                                </>
                                            )}
                                        </Box>
                                    )}


                                </Flex>
                            </Dialog.Body>

                            <Dialog.Footer>
                                <Flex gap={3}>
                                    <Button variant="outline" onClick={onClose} disabled={loading}>
                                        Cancel
                                    </Button>
                                    <Button
                                        type="submit"
                                        colorPalette="blue"
                                        loading={loading}
                                        disabled={!formData.connector_type}
                                    >
                                        {connector ? 'Update' : 'Create'}
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

export default ConnectorFormDialog;
