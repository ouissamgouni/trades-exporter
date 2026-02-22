import React, { useState, useEffect } from 'react';
import {
    Badge,
    Box,
    Button,
    HStack,
    Heading,
    IconButton,
    Switch,
    Table,
    Text,
    VStack,
} from '@chakra-ui/react';
import { FiEdit2, FiPlus, FiRefreshCw, FiTrash2 } from 'react-icons/fi';

import { Account, AccountConnector, ConnectorTypeInfo, API_URL } from '../types';
import ConnectorFormDialog from './ConnectorFormDialog';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

interface AccountConnectorsProps {
    account: Account;
    onClose?: () => void;
}

const AccountConnectors: React.FC<AccountConnectorsProps> = ({ account }) => {
    const [connectors, setConnectors] = useState<AccountConnector[]>([]);
    const [connectorTypes, setConnectorTypes] = useState<ConnectorTypeInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [editingConnector, setEditingConnector] = useState<AccountConnector | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    const deleteConfirm = useConfirmDialog<AccountConnector>();

    const fetchConnectors = async () => {
        setLoading(true);
        try {
            const response = await fetch(`${API_URL}/accounts/${account.id}/connectors/`);
            if (!response.ok) throw new Error('Failed to fetch connectors');
            const data = await response.json();
            setConnectors(data);
        } catch (error) {
            console.error('Error fetching connectors:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchConnectorTypes = async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/${account.id}/connectors/types`);
            if (!response.ok) throw new Error('Failed to fetch connector types');
            const data = await response.json();
            setConnectorTypes(data);
        } catch (error) {
            console.error('Error fetching connector types:', error);
        }
    };

    useEffect(() => {
        fetchConnectors();
        fetchConnectorTypes();
    }, [account.id]);

    const handleToggle = async (connector: AccountConnector) => {
        try {
            const response = await fetch(
                `${API_URL}/accounts/${account.id}/connectors/${connector.connector_type}/toggle`,
                { method: 'PATCH' }
            );
            if (!response.ok) throw new Error('Failed to toggle connector');
            fetchConnectors();
        } catch (error) {
            console.error('Error toggling connector:', error);
            toaster.error({ title: 'Error', description: 'Failed to toggle connector' });
        }
    };

    const handleDelete = (connector: AccountConnector) => {
        deleteConfirm.open(connector);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const connector = deleteConfirm.data;
        try {
            const response = await fetch(
                `${API_URL}/accounts/${account.id}/connectors/${connector.connector_type}`,
                { method: 'DELETE' }
            );
            if (!response.ok) throw new Error('Failed to delete connector');
            fetchConnectors();
        } catch (error) {
            console.error('Error deleting connector:', error);
            toaster.error({ title: 'Error', description: 'Failed to delete connector' });
        }
    };

    const handleEdit = (connector: AccountConnector) => {
        setEditingConnector(connector);
        setIsDialogOpen(true);
    };

    const handleCreate = () => {
        setEditingConnector(null);
        setIsDialogOpen(true);
    };

    const handleDialogClose = () => {
        setEditingConnector(null);
        setIsDialogOpen(false);
        fetchConnectors();
    };

    const getStatusBadge = (status?: string) => {
        switch (status) {
            case 'success':
                return <Badge colorScheme="green">Success</Badge>;
            case 'failed':
                return <Badge colorScheme="red">Failed</Badge>;
            case 'running':
                return <Badge colorScheme="blue">Running</Badge>;
            default:
                return <Badge colorScheme="gray">Pending</Badge>;
        }
    };

    const getCategoryBadge = (connectorType: string) => {
        const info = connectorTypes.find(t => t.type === connectorType);
        if (!info) return null;

        const colors: Record<string, string> = {
            cex: 'blue',
            onchain: 'purple',
            broker: 'green',
        };

        return (
            <Badge colorScheme={colors[info.category] || 'gray'} size="sm">
                {info.category.toUpperCase()}
            </Badge>
        );
    };

    const getConnectorDisplayName = (connectorType: string) => {
        const info = connectorTypes.find(t => t.type === connectorType);
        return info?.display_name || connectorType;
    };

    // Get available connector types (not already configured)
    const availableTypes = connectorTypes.filter(
        t => !connectors.some(c => c.connector_type === t.type)
    );

    // Memoize to prevent unnecessary re-renders of ConnectorFormDialog
    const existingConnectorTypes = React.useMemo(
        () => connectors.map(c => c.connector_type),
        [connectors]
    );

    return (
        <Box>
            <VStack align="stretch" gap={4}>
                {/* Header */}
                <HStack justify="space-between">
                    <Heading size="md">Connectors for {account.name}</Heading>
                    <HStack>
                        <IconButton
                            aria-label="Refresh"
                            size="sm"
                            variant="ghost"
                            onClick={fetchConnectors}
                        >
                            <FiRefreshCw />
                        </IconButton>
                        <Button
                            size="sm"
                            colorScheme="blue"
                            onClick={handleCreate}
                            disabled={availableTypes.length === 0}
                        >
                            <FiPlus /> Add Connector
                        </Button>
                    </HStack>
                </HStack>

                {/* Connectors Table */}
                {connectors.length === 0 ? (
                    <Box p={8} textAlign="center" borderWidth="1px" borderRadius="lg" bg="gray.50">
                        <Text color="gray.600" mb={4}>No connectors configured for this account</Text>
                        <Button colorScheme="blue" onClick={handleCreate}>
                            <FiPlus /> Add First Connector
                        </Button>
                    </Box>
                ) : (
                    <Box borderWidth="1px" borderRadius="lg" overflow="hidden">
                        <Table.Root size="sm">
                            <Table.Header>
                                <Table.Row>
                                    <Table.ColumnHeader>Connector</Table.ColumnHeader>
                                    <Table.ColumnHeader>Config</Table.ColumnHeader>
                                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                                    <Table.ColumnHeader>Last Sync</Table.ColumnHeader>
                                    <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                                    <Table.ColumnHeader textAlign="right">Actions</Table.ColumnHeader>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {connectors.map((connector) => (
                                    <Table.Row key={connector.id}>
                                        <Table.Cell>
                                            <VStack align="start" gap={1}>
                                                <Text fontWeight="medium">
                                                    {getConnectorDisplayName(connector.connector_type)}
                                                </Text>
                                                {getCategoryBadge(connector.connector_type)}
                                            </VStack>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <VStack align="start" gap={0}>
                                                {connector.config?.chain && (
                                                    <Text fontSize="sm">Chain: {connector.config.chain}</Text>
                                                )}
                                                {connector.config?.address && (
                                                    <Text fontSize="xs" color="gray.500" maxW="150px" truncate>
                                                        {connector.config.address}
                                                    </Text>
                                                )}
                                                {connector.config?.symbols && (
                                                    <Text fontSize="sm">
                                                        {connector.config.symbols.slice(0, 3).join(', ')}
                                                        {connector.config.symbols.length > 3 && '...'}
                                                    </Text>
                                                )}
                                                {connector.config?.start_date && (
                                                    <Text fontSize="xs" color="gray.500">
                                                        Since: {connector.config.start_date}
                                                    </Text>
                                                )}
                                            </VStack>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <VStack align="start" gap={1}>
                                                {getStatusBadge(connector.last_sync_status)}
                                                {connector.last_error && (
                                                    <Text fontSize="xs" color="red.500" maxW="150px" truncate>
                                                        {connector.last_error}
                                                    </Text>
                                                )}
                                            </VStack>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontSize="sm" color="gray.600">
                                                {connector.last_sync_at
                                                    ? new Date(connector.last_sync_at).toLocaleString()
                                                    : 'Never'}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Switch.Root
                                                checked={connector.enabled}
                                                onCheckedChange={() => handleToggle(connector)}
                                                colorPalette="green"
                                            >
                                                <Switch.HiddenInput />
                                                <Switch.Control>
                                                    <Switch.Thumb />
                                                </Switch.Control>
                                            </Switch.Root>
                                        </Table.Cell>
                                        <Table.Cell textAlign="right">
                                            <HStack justify="flex-end" gap={1}>
                                                <IconButton
                                                    aria-label="Edit"
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => handleEdit(connector)}
                                                >
                                                    <FiEdit2 />
                                                </IconButton>
                                                <IconButton
                                                    aria-label="Delete"
                                                    size="sm"
                                                    variant="ghost"
                                                    colorScheme="red"
                                                    onClick={() => handleDelete(connector)}
                                                >
                                                    <FiTrash2 />
                                                </IconButton>
                                            </HStack>
                                        </Table.Cell>
                                    </Table.Row>
                                ))}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                )}

                {/* Priority Note */}
                <Text fontSize="xs" color="gray.500">
                    Connectors are synced in order of priority (lower number = higher priority)
                </Text>
            </VStack>

            {/* Connector Form Dialog */}
            <ConnectorFormDialog
                isOpen={isDialogOpen}
                onClose={handleDialogClose}
                account={account}
                connector={editingConnector}
                connectorTypes={connectorTypes}
                existingConnectorTypes={existingConnectorTypes}
            />

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Connector"
                message={deleteConfirm.data ? `Delete ${deleteConfirm.data.connector_type} connector?` : ''}
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};

export default AccountConnectors;
