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

import { AccountConnector, ConnectorTypeInfo, API_URL } from '../types';

interface ConnectorFormDialogProps {
    isOpen: boolean;
    onClose: () => void;
    accountId: number;
    connector?: AccountConnector | null;
    connectorTypes: ConnectorTypeInfo[];
    existingConnectorTypes: string[];
}

const ConnectorFormDialog: React.FC<ConnectorFormDialogProps> = ({
    isOpen,
    onClose,
    accountId,
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

    // Get available types for new connectors (not already configured)
    const availableTypes = connector
        ? connectorTypes // If editing, show all types
        : connectorTypes.filter(t => !existingConnectorTypes.includes(t.type));

    const selectedTypeInfo = connectorTypes.find(t => t.type === formData.connector_type);

    useEffect(() => {
        if (connector) {
            setFormData({
                connector_type: connector.connector_type,
                enabled: connector.enabled,
                config: connector.config || {},
                credentials_ref: connector.credentials_ref || '',
                sync_priority: connector.sync_priority,
            });
        } else {
            // Only reset form when dialog opens, not on every availableTypes change
            const firstAvailable = connectorTypes.find(t => !existingConnectorTypes.includes(t.type));
            setFormData({
                connector_type: firstAvailable?.type || '',
                enabled: true,
                config: {},
                credentials_ref: '',
                sync_priority: 100,
            });
        }
        setError('');
    }, [connector, isOpen, connectorTypes, existingConnectorTypes]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const payload = {
                connector_type: formData.connector_type,
                enabled: formData.enabled,
                config: formData.config,
                credentials_ref: formData.credentials_ref || null,
                sync_priority: formData.sync_priority,
            };

            const url = connector
                ? `${API_URL}/accounts/${accountId}/connectors/${connector.connector_type}`
                : `${API_URL}/accounts/${accountId}/connectors/`;

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

            onClose();
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    const updateConfig = (key: string, value: any) => {
        setFormData(prev => ({
            ...prev,
            config: { ...prev.config, [key]: value },
        }));
    };

    const renderConfigFields = () => {
        if (!selectedTypeInfo) return null;

        const fields = [];

        // Chain selector for on-chain connectors
        if (selectedTypeInfo.supported_chains?.length) {
            fields.push(
                <Box key="chain">
                    <Text fontWeight="medium" mb={1}>
                        Chain <Text as="span" color="red.500">*</Text>
                    </Text>
                    <NativeSelect.Root>
                        <NativeSelect.Field
                            value={formData.config.chain || ''}
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
                </Box>
            );
        }

        // Address field for on-chain connectors
        if (selectedTypeInfo.required_config.includes('address') ||
            selectedTypeInfo.optional_config.includes('address')) {
            const isRequired = selectedTypeInfo.required_config.includes('address');
            fields.push(
                <Box key="address">
                    <Text fontWeight="medium" mb={1}>
                        Wallet Address {isRequired && <Text as="span" color="red.500">*</Text>}
                    </Text>
                    <Input
                        value={formData.config.address || ''}
                        onChange={(e) => updateConfig('address', e.target.value)}
                        placeholder="0x..."
                        required={isRequired}
                    />
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
