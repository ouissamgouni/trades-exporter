import React, { useState, useEffect } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    HStack,
    IconButton,
    Switch,
    Table,
    Text,
    VStack,
} from '@chakra-ui/react';
import { FiEdit2, FiPlus, FiRefreshCw, FiTrash2 } from 'react-icons/fi';
import { LuEraser } from 'react-icons/lu';

import { Account, AccountConnector, ConnectorTypeInfo, API_URL } from '../types';
import ConnectorFormDialog from './ConnectorFormDialog';
import { CleanupDialog } from './CleanupDialog';
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

    // Cleanup dialog state
    const [cleanupTarget, setCleanupTarget] = useState<{ connectorIds: number[]; title: string; mode: 'purge' | 'delete' } | null>(null);
    const isCleanupOpen = cleanupTarget !== null;

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

    const handlePurge = (connector: AccountConnector) => {
        setCleanupTarget({
            connectorIds: [connector.id],
            title: `Purge Data: ${connector.connector_type}`,
            mode: 'purge',
        });
    };

    const handleDelete = (connector: AccountConnector) => {
        setCleanupTarget({
            connectorIds: [connector.id],
            title: `Delete Connector: ${connector.connector_type}`,
            mode: 'delete',
        });
    };

    const handleCleanupClose = () => {
        setCleanupTarget(null);
    };

    const handleCleanupCompleted = () => {
        setCleanupTarget(null);
        fetchConnectors();
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
                return <Badge colorScheme="green" size="xs" fontSize="2xs">OK</Badge>;
            case 'failed':
                return <Badge colorScheme="red" size="xs" fontSize="2xs">Fail</Badge>;
            case 'running':
                return <Badge colorScheme="blue" size="xs" fontSize="2xs">Run</Badge>;
            default:
                return <Badge colorScheme="gray" size="xs" fontSize="2xs">—</Badge>;
        }
    };

    const formatRelativeTime = (dateStr: string): string => {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
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
            <Badge colorScheme={colors[info.category] || 'gray'} size="xs" fontSize="2xs">
                {info.category}
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
            <VStack align="stretch" gap={2}>
                {/* Connectors Table */}
                {connectors.length === 0 ? (
                    <Box p={4} textAlign="center" borderWidth="1px" borderRadius="md" bg="gray.50">
                        <Text color="gray.600" mb={2} fontSize="xs">No connectors configured</Text>
                        <Button size="xs" colorScheme="blue" onClick={handleCreate}>
                            <FiPlus size={10} /> Add Connector
                        </Button>
                    </Box>
                ) : (
                    <>
                        <Flex justify="flex-end" gap={1}>
                            <IconButton
                                aria-label="Refresh"
                                size="2xs"
                                variant="ghost"
                                onClick={fetchConnectors}
                            >
                                <FiRefreshCw size={10} />
                            </IconButton>
                            <Button
                                size="2xs"
                                colorScheme="blue"
                                onClick={handleCreate}
                                disabled={availableTypes.length === 0}
                            >
                                <FiPlus size={10} /> Add
                            </Button>
                        </Flex>
                        <Box borderWidth="1px" borderRadius="lg" overflowX="auto">
                            <Table.Root size="sm" fontSize="xs" minW="480px">
                                <Table.Header>
                                    <Table.Row>
                                        <Table.ColumnHeader fontSize="2xs">Connector</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="2xs">Config</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="2xs">Status</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="2xs">Enabled</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Actions</Table.ColumnHeader>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {connectors.map((connector) => (
                                        <Table.Row key={connector.id}>
                                            <Table.Cell whiteSpace="nowrap">
                                                <VStack align="start" gap={0.5}>
                                                    <Text fontWeight="medium" fontSize="xs">
                                                        {getConnectorDisplayName(connector.connector_type)}
                                                    </Text>
                                                    {getCategoryBadge(connector.connector_type)}
                                                </VStack>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <VStack align="start" gap={0}>
                                                    {connector.config?.chain && (
                                                        <Text fontSize="2xs">{connector.config.chain}</Text>
                                                    )}
                                                    {connector.config?.address && (
                                                        <Text fontSize="2xs" color="gray.500" maxW="100px" truncate>
                                                            {connector.config.address}
                                                        </Text>
                                                    )}
                                                    {connector.config?.wallet_address && (
                                                        <Text fontSize="2xs" color="gray.500" maxW="100px" truncate title={connector.config.wallet_address}>
                                                            {connector.config.wallet_address}
                                                        </Text>
                                                    )}
                                                    {connector.config?.symbols && (
                                                        <Text fontSize="2xs">
                                                            {connector.config.symbols.slice(0, 3).join(', ')}
                                                            {connector.config.symbols.length > 3 && '...'}
                                                        </Text>
                                                    )}
                                                    {connector.config?.start_datetime && (
                                                        <Text fontSize="2xs" color="gray.500">
                                                            Since: {new Date(connector.config.start_datetime).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' })}
                                                        </Text>
                                                    )}
                                                    {connector.config?.default_file_name && (
                                                        <Text fontSize="2xs" color="gray.500" maxW="100px" truncate title={connector.config.default_file_name}>
                                                            📁 {connector.config.default_file_name}
                                                        </Text>
                                                    )}
                                                </VStack>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <VStack align="start" gap={0.5}>
                                                    <HStack gap={1}>
                                                        {getStatusBadge(connector.last_sync_status)}
                                                        <Text fontSize="2xs" color="gray.500">
                                                            {connector.last_sync_at
                                                                ? formatRelativeTime(connector.last_sync_at)
                                                                : 'Never'}
                                                        </Text>
                                                    </HStack>
                                                    {connector.last_error && (
                                                        <Text fontSize="2xs" color="red.500" maxW="150px" truncate title={connector.last_error}>
                                                            {connector.last_error}
                                                        </Text>
                                                    )}
                                                </VStack>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Switch.Root
                                                    size="sm"
                                                    checked={connector.enabled}
                                                    onCheckedChange={() => handleToggle(connector)}
                                                    colorPalette="green"
                                                >
                                                    <Switch.HiddenInput />
                                                    <Switch.Control w="22px" h="12px">
                                                        <Switch.Thumb w="10px" h="10px" />
                                                    </Switch.Control>
                                                </Switch.Root>
                                            </Table.Cell>
                                            <Table.Cell whiteSpace="nowrap">
                                                <HStack justify="flex-end" gap={0.5}>
                                                    <IconButton
                                                        aria-label="Purge data"
                                                        size="2xs"
                                                        variant="ghost"
                                                        title="Purge connector data (keep config)"
                                                        onClick={() => handlePurge(connector)}
                                                    >
                                                        <LuEraser size={10} />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Edit"
                                                        size="2xs"
                                                        variant="ghost"
                                                        onClick={() => handleEdit(connector)}
                                                    >
                                                        <FiEdit2 size={10} />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Delete"
                                                        size="2xs"
                                                        variant="ghost"
                                                        colorScheme="red"
                                                        onClick={() => handleDelete(connector)}
                                                    >
                                                        <FiTrash2 size={10} />
                                                    </IconButton>
                                                </HStack>
                                            </Table.Cell>
                                        </Table.Row>
                                    ))}
                                </Table.Body>
                            </Table.Root>
                        </Box>
                    </>
                )}

                {/* Priority Note */}
                <Text fontSize="2xs" color="gray.500">
                    Synced by priority (lower = first)
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
                usedColors={connectors.map(c => c.color).filter((c): c is string => !!c)}
            />

            {/* Cleanup / Delete Dialog */}
            <CleanupDialog
                isOpen={isCleanupOpen}
                onClose={handleCleanupClose}
                connectorIds={cleanupTarget?.connectorIds ?? []}
                defaultMode={cleanupTarget?.mode ?? 'purge'}
                title={cleanupTarget?.title ?? ''}
                onCompleted={handleCleanupCompleted}
            />
        </Box>
    );
};

export default AccountConnectors;
