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
            // Only lock chain for unambiguous address formats (XRP, Solana)
            // EVM addresses (0x) are valid on multiple chains, so pre-select but don't lock
            const isChainInherited = isWalletAccount && detectedChain && detectedChain !== 'ethereum';

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
                                                accept={selectedTypeInfo.type.includes('okx') ? '.csv' : '.xlsx,.xls'}
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
