import React, { useState, useEffect } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    IconButton,
    NativeSelect,
    Spinner,
    Switch,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiRefreshCw, FiTrash2, FiChevronDown, FiChevronRight } from 'react-icons/fi';

import { ConnectorWithAccount, ConnectorTypeInfo, API_URL } from '../types';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

interface ConnectorTypeGroup {
    type: string;
    displayName: string;
    category: string;
    connectors: ConnectorWithAccount[];
    enabledCount: number;
    totalCount: number;
}

/**
 * ConnectorsManager - Standalone component for viewing and managing all connectors
 * grouped by connector type. Each row shows a connector type with linked accounts.
 */
const ConnectorsManager: React.FC = () => {
    const [connectors, setConnectors] = useState<ConnectorWithAccount[]>([]);
    const [connectorTypes, setConnectorTypes] = useState<ConnectorTypeInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

    // Filters
    const [enabledFilter, setEnabledFilter] = useState<string>('');
    const [categoryFilter, setCategoryFilter] = useState<string>('');

    const deleteConfirm = useConfirmDialog<ConnectorWithAccount>();

    const fetchConnectors = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (enabledFilter === 'true') params.append('enabled_only', 'true');

            const response = await fetch(`${API_URL}/connectors?${params}`);
            if (!response.ok) throw new Error('Failed to fetch connectors');
            const data = await response.json();
            setConnectors(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const fetchConnectorTypes = async () => {
        try {
            const response = await fetch(`${API_URL}/connectors/types`);
            if (!response.ok) throw new Error('Failed to fetch connector types');
            const data = await response.json();
            setConnectorTypes(data);
        } catch (err) {
            console.error('Error fetching connector types:', err);
        }
    };

    useEffect(() => {
        fetchConnectors();
        fetchConnectorTypes();
    }, [enabledFilter]);

    // Group connectors by type
    const groupedConnectors: ConnectorTypeGroup[] = React.useMemo(() => {
        const groups: Record<string, ConnectorTypeGroup> = {};

        connectors.forEach(connector => {
            const type = connector.connector_type;
            if (!groups[type]) {
                const typeInfo = connectorTypes.find(t => t.type === type);
                groups[type] = {
                    type,
                    displayName: typeInfo?.display_name || type,
                    category: typeInfo?.category || 'unknown',
                    connectors: [],
                    enabledCount: 0,
                    totalCount: 0,
                };
            }
            groups[type].connectors.push(connector);
            groups[type].totalCount++;
            if (connector.enabled) groups[type].enabledCount++;
        });

        let result = Object.values(groups);

        // Apply category filter
        if (categoryFilter) {
            result = result.filter(g => g.category === categoryFilter);
        }

        // Sort by category then by display name
        return result.sort((a, b) => {
            if (a.category !== b.category) return a.category.localeCompare(b.category);
            return a.displayName.localeCompare(b.displayName);
        });
    }, [connectors, connectorTypes, categoryFilter]);

    const toggleExpanded = (type: string) => {
        setExpandedTypes(prev => {
            const next = new Set(prev);
            if (next.has(type)) {
                next.delete(type);
            } else {
                next.add(type);
            }
            return next;
        });
    };

    const expandAll = () => {
        setExpandedTypes(new Set(groupedConnectors.map(g => g.type)));
    };

    const collapseAll = () => {
        setExpandedTypes(new Set());
    };

    const handleToggle = async (connector: ConnectorWithAccount) => {
        try {
            const response = await fetch(
                `${API_URL}/connectors/${connector.id}/toggle`,
                { method: 'PATCH' }
            );
            if (!response.ok) throw new Error('Failed to toggle connector');
            fetchConnectors();
        } catch (err) {
            console.error('Error toggling connector:', err);
            toaster.error({ title: 'Error', description: 'Failed to toggle connector' });
        }
    };

    const handleDelete = (connector: ConnectorWithAccount) => {
        deleteConfirm.open(connector);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const connector = deleteConfirm.data;
        try {
            const response = await fetch(
                `${API_URL}/connectors/${connector.id}`,
                { method: 'DELETE' }
            );
            if (!response.ok) throw new Error('Failed to delete connector');
            fetchConnectors();
        } catch (err) {
            console.error('Error deleting connector:', err);
            toaster.error({ title: 'Error', description: 'Failed to delete connector' });
        }
    };

    const getStatusBadge = (status?: string) => {
        switch (status) {
            case 'success':
                return <Badge colorPalette="green">Success</Badge>;
            case 'warning':
                return <Badge colorPalette="orange">Warning</Badge>;
            case 'failed':
                return <Badge colorPalette="red">Failed</Badge>;
            case 'running':
                return <Badge colorPalette="blue">Running</Badge>;
            default:
                return <Badge colorPalette="gray">Pending</Badge>;
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
            <Badge colorPalette={colors[info.category] || 'gray'} size="sm">
                {info.category.toUpperCase()}
            </Badge>
        );
    };

    const getConnectorDisplayName = (connectorType: string) => {
        const info = connectorTypes.find(t => t.type === connectorType);
        return info?.display_name || connectorType;
    };

    const getAccountTypeBadge = (accountType: string) => {
        const colors: Record<string, string> = {
            cex: 'blue',
            dex: 'cyan',
            wallet: 'purple',
            broker: 'green',
            bank: 'teal',
            investment: 'orange',
        };
        return (
            <Badge colorPalette={colors[accountType] || 'gray'} size="sm">
                {accountType.toUpperCase()}
            </Badge>
        );
    };

    // Get unique categories for filter
    const uniqueCategories = [...new Set(connectorTypes.map(t => t.category))];

    if (loading && connectors.length === 0) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading connectors...</Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                <Text color="red.600">Error: {error}</Text>
            </Box>
        );
    }

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>Connectors by Type</Heading>
                    <Text color="gray.600" fontSize="sm">
                        View connectors grouped by type. Expand to see linked accounts and manage individual connectors.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button onClick={expandAll} variant="outline" size="sm">
                        Expand All
                    </Button>
                    <Button onClick={collapseAll} variant="outline" size="sm">
                        Collapse All
                    </Button>
                    <Button onClick={fetchConnectors} variant="outline" size="sm">
                        <FiRefreshCw /> Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Filters */}
            <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Status:</Text>
                    <NativeSelect.Root size="sm" width="auto">
                        <NativeSelect.Field
                            value={enabledFilter}
                            onChange={e => setEnabledFilter(e.target.value)}
                        >
                            <option value="">All</option>
                            <option value="true">Enabled Only</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Category:</Text>
                    <NativeSelect.Root size="sm" width="auto">
                        <NativeSelect.Field
                            value={categoryFilter}
                            onChange={e => setCategoryFilter(e.target.value)}
                        >
                            <option value="">All Categories</option>
                            {uniqueCategories.map(cat => (
                                <option key={cat} value={cat}>
                                    {cat.toUpperCase()}
                                </option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(enabledFilter || categoryFilter) && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            setEnabledFilter('');
                            setCategoryFilter('');
                        }}
                    >
                        Clear Filters
                    </Button>
                )}
            </Flex>

            {/* Connectors Table - Grouped by Type */}
            {groupedConnectors.length === 0 ? (
                <Box p={8} textAlign="center" borderWidth="1px" borderRadius="lg" bg="gray.50">
                    <Text color="gray.600" mb={4}>No connectors found</Text>
                    <Text fontSize="sm" color="gray.500">
                        Create connectors from the Accounts tab by adding connectors to your accounts.
                    </Text>
                </Box>
            ) : (
                <Box borderWidth="1px" borderRadius="lg" overflow="hidden" bg="white">
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <Table.ColumnHeader width="40px"></Table.ColumnHeader>
                                <Table.ColumnHeader>Connector Type</Table.ColumnHeader>
                                <Table.ColumnHeader>Category</Table.ColumnHeader>
                                <Table.ColumnHeader>Linked Accounts</Table.ColumnHeader>
                                <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {groupedConnectors.map((group) => (
                                <React.Fragment key={group.type}>
                                    {/* Connector Type Row */}
                                    <Table.Row
                                        onClick={() => toggleExpanded(group.type)}
                                        cursor="pointer"
                                        _hover={{ bg: 'gray.50' }}
                                        bg={expandedTypes.has(group.type) ? 'blue.50' : undefined}
                                    >
                                        <Table.Cell>
                                            <IconButton
                                                aria-label="Expand"
                                                size="xs"
                                                variant="ghost"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleExpanded(group.type);
                                                }}
                                            >
                                                {expandedTypes.has(group.type) ? <FiChevronDown /> : <FiChevronRight />}
                                            </IconButton>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontWeight="semibold">{group.displayName}</Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {getCategoryBadge(group.type)}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex gap={1} flexWrap="wrap">
                                                {group.connectors.slice(0, 4).map(c => (
                                                    <Badge
                                                        key={c.id}
                                                        colorPalette={c.enabled ? 'green' : 'gray'}
                                                        size="sm"
                                                        variant={c.enabled ? 'solid' : 'outline'}
                                                    >
                                                        {c.account_name}
                                                    </Badge>
                                                ))}
                                                {group.connectors.length > 4 && (
                                                    <Badge colorPalette="gray" size="sm">
                                                        +{group.connectors.length - 4} more
                                                    </Badge>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontSize="sm" color="gray.600">
                                                {group.enabledCount}/{group.totalCount}
                                            </Text>
                                        </Table.Cell>
                                    </Table.Row>

                                    {/* Expanded Account Details */}
                                    {expandedTypes.has(group.type) && group.connectors.map(connector => (
                                        <Table.Row key={connector.id} bg="gray.50">
                                            <Table.Cell></Table.Cell>
                                            <Table.Cell pl={8}>
                                                <Flex direction="column" gap={0}>
                                                    <Text fontWeight="medium" fontSize="sm">{connector.account_name}</Text>
                                                    {getAccountTypeBadge(connector.account_type)}
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex direction="column" gap={0}>
                                                    {connector.config?.chain && (
                                                        <Text fontSize="xs">Chain: {connector.config.chain}</Text>
                                                    )}
                                                    {connector.config?.address && (
                                                        <Text fontSize="xs" color="gray.500" maxW="120px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                                            {connector.config.address}
                                                        </Text>
                                                    )}
                                                    {connector.config?.start_date && (
                                                        <Text fontSize="xs" color="gray.500">
                                                            Since: {connector.config.start_date}
                                                        </Text>
                                                    )}
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex direction="column" gap={1}>
                                                    {getStatusBadge(connector.last_sync_status)}
                                                    <Text fontSize="xs" color="gray.500">
                                                        {connector.last_sync_at
                                                            ? new Date(connector.last_sync_at).toLocaleString()
                                                            : 'Never synced'}
                                                    </Text>
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex gap={2} align="center">
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
                                                    <IconButton
                                                        aria-label="Delete"
                                                        size="xs"
                                                        variant="ghost"
                                                        colorPalette="red"
                                                        onClick={() => handleDelete(connector)}
                                                    >
                                                        <FiTrash2 />
                                                    </IconButton>
                                                </Flex>
                                            </Table.Cell>
                                        </Table.Row>
                                    ))}
                                </React.Fragment>
                            ))}
                        </Table.Body>
                    </Table.Root>
                </Box>
            )}

            {/* Summary */}
            <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                <Text fontSize="sm" color="gray.600">
                    <strong>{groupedConnectors.length}</strong> connector type(s) •{' '}
                    <strong>{connectors.length}</strong> total connector(s)
                    {enabledFilter === 'true' && <Text as="span"> • Showing enabled only</Text>}
                    {categoryFilter && <Text as="span"> • Category: <strong>{categoryFilter.toUpperCase()}</strong></Text>}
                </Text>
            </Box>

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Connector"
                message={deleteConfirm.data ? `Delete ${deleteConfirm.data.connector_type} connector for ${deleteConfirm.data.account_name}?` : ''}
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};

export default ConnectorsManager;
