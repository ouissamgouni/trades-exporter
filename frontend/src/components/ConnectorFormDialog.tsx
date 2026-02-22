import React, { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    NativeSelect,
    Portal,
    Text,
    Textarea,
    Switch,
} from '@chakra-ui/react';

import { Account, AccountConnector, ConnectorTypeInfo, API_URL } from '../types';
import FileDropzone from './FileDropzone';

interface ConnectorFormDialogProps {
    isOpen: boolean;
    onClose: () => void;
    account: Account;
    connector?: AccountConnector | null;
    connectorTypes: ConnectorTypeInfo[];
    existingConnectorTypes: string[];
}

const ConnectorFormDialog: React.FC<ConnectorFormDialogProps> = ({
    isOpen,
    onClose,
    account,
    connector,
    connectorTypes,
    existingConnectorTypes,
}) => {
    const [formData, setFormData] = useState({
        connector_type: '',
        enabled: true,
        config: {} as Record<string, any>,
        credentials_ref: '',
        sync_priority: 100,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [testMode, setTestMode] = useState(false);
    const [fixtureFile, setFixtureFile] = useState<File | null>(null);
    const [uploadingFixture, setUploadingFixture] = useState(false);
    const [currentFixtureName, setCurrentFixtureName] = useState<string | null>(null);

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
            });
            // Load test mode state from config
            setTestMode(connector.config?.test_mode || false);
            // Fetch fixture status if editing
            if (connector.id) {
                fetch(`${API_URL}/fixtures/connectors/${connector.id}/test-fixture`)
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        if (data?.has_fixture) {
                            setCurrentFixtureName(`${connector.id}.json (${data.item_count} items)`);
                        } else {
                            setCurrentFixtureName(null);
                        }
                    })
                    .catch(() => setCurrentFixtureName(null));
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
            });
            setTestMode(false);
            setCurrentFixtureName(null);
            setFixtureFile(null);
        }
        setError('');
    }, [isOpen, connector, connectorTypes, existingConnectorTypes, account]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Build config with test_mode if enabled
            const configToSave = { ...formData.config };
            if (testMode) {
                configToSave.test_mode = true;
            } else {
                delete configToSave.test_mode;
                delete configToSave.test_file_path;
            }
            
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

            // Upload fixture file if test mode is enabled and we have a file
            if (testMode && fixtureFile && savedConnector.id) {
                setUploadingFixture(true);
                const fixtureFormData = new FormData();
                fixtureFormData.append('file', fixtureFile);

                const fixtureResponse = await fetch(
                    `${API_URL}/fixtures/connectors/${savedConnector.id}/test-fixture`,
                    {
                        method: 'POST',
                        body: fixtureFormData,
                    }
                );

                if (!fixtureResponse.ok) {
                    const errorData = await fixtureResponse.json();
                    throw new Error(errorData.detail || 'Failed to upload fixture');
                }
            }

            onClose();
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
            setUploadingFixture(false);
        }
    };

    const handleRemoveFixture = async () => {
        if (!connector?.id) return;

        try {
            const response = await fetch(
                `${API_URL}/fixtures/connectors/${connector.id}/test-fixture`,
                { method: 'DELETE' }
            );
            if (response.ok) {
                setCurrentFixtureName(null);
                setTestMode(false);
            }
        } catch (err) {
            console.error('Failed to remove fixture:', err);
        }
    };

    const updateConfig = (key: string, value: any) => {
        setFormData(prev => ({
            ...prev,
            config: { ...prev.config, [key]: value },
        }));
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
        const shouldInheritAddress = isWalletAccount && accountAddress;

        // Chain selector for on-chain connectors
        if (selectedTypeInfo.supported_chains?.length) {
            // For wallet accounts, auto-select detected chain
            const chainValue = detectedChain || formData.config.chain || '';
            const isChainInherited = isWalletAccount && detectedChain;
            
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

        // Start block for on-chain
        if (selectedTypeInfo.optional_config.includes('start_block')) {
            fields.push(
                <Box key="start_block">
                    <Text fontWeight="medium" mb={1}>Start Block</Text>
                    <Input
                        type="number"
                        value={formData.config.start_block || ''}
                        onChange={(e) => updateConfig('start_block', parseInt(e.target.value) || null)}
                        placeholder="Leave empty for all history"
                    />
                </Box>
            );
        }

        // Start date for CEX
        if (selectedTypeInfo.optional_config.includes('start_date')) {
            fields.push(
                <Box key="start_date">
                    <Text fontWeight="medium" mb={1}>Start Date</Text>
                    <Input
                        type="date"
                        value={formData.config.start_date || ''}
                        onChange={(e) => updateConfig('start_date', e.target.value)}
                    />
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

                                    {/* Test Mode Section */}
                                    <Box
                                        p={4}
                                        borderWidth="1px"
                                        borderRadius="md"
                                        borderColor={testMode ? 'orange.300' : 'gray.200'}
                                        bg={testMode ? 'orange.50' : 'transparent'}
                                    >
                                        <Flex align="center" justify="space-between" mb={testMode ? 3 : 0}>
                                            <Box>
                                                <Text fontWeight="medium">🧪 Test Mode</Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    Use fixture data instead of live API
                                                </Text>
                                            </Box>
                                            <Switch.Root
                                                checked={testMode}
                                                onCheckedChange={(e) => setTestMode(e.checked)}
                                            >
                                                <Switch.HiddenInput />
                                                <Switch.Control>
                                                    <Switch.Thumb />
                                                </Switch.Control>
                                            </Switch.Root>
                                        </Flex>

                                        {testMode && (
                                            <Box mt={3}>
                                                <Text fontSize="sm" fontWeight="medium" mb={2}>
                                                    Test Fixture File
                                                </Text>
                                                <FileDropzone
                                                    onFileSelect={(file) => setFixtureFile(file)}
                                                    currentFileName={fixtureFile?.name || currentFixtureName}
                                                    onRemove={connector?.id ? handleRemoveFixture : () => setFixtureFile(null)}
                                                    accept=".json"
                                                    maxSize={1024 * 1024}
                                                    disabled={uploadingFixture}
                                                />
                                                {!connector && !fixtureFile && (
                                                    <Text fontSize="xs" color="gray.500" mt={2}>
                                                        Upload a JSON array of transactions to use for testing.
                                                        You can also upload after creating the connector.
                                                    </Text>
                                                )}
                                            </Box>
                                        )}
                                    </Box>
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
