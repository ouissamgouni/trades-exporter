import React, { useState, useEffect } from 'react';
import {
    Badge,
    type BadgeColorScheme,
    Button,
    Heading,
    Spinner,
    Text,
} from './ui/primitives';
import { FiRefreshCw, FiTrash2, FiChevronDown, FiChevronRight } from 'react-icons/fi';

import { ConnectorWithAccount, ConnectorTypeInfo, API_URL } from '../types';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

const VALID_BADGE_COLORS: BadgeColorScheme[] = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toBadgeColor = (c: string): BadgeColorScheme =>
    (VALID_BADGE_COLORS as string[]).includes(c) ? (c as BadgeColorScheme) : 'gray';

interface ToggleSwitchProps {
    checked: boolean;
    onChange: () => void;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative inline-flex h-4 w-7 items-center transition-colors ${checked ? 'bg-green-500' : 'bg-gray-300'}`}
    >
        <span
            className={`inline-block h-3 w-3 transform bg-white transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
    </button>
);

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
                return <Badge colorScheme="green">Success</Badge>;
            case 'warning':
                return <Badge colorScheme="orange">Warning</Badge>;
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
            <Badge colorScheme={toBadgeColor(colors[info.category] || 'gray')} className="text-[10px]">
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
            dex: 'blue',
            wallet: 'purple',
            broker: 'green',
            bank: 'green',
            investment: 'orange',
        };
        return (
            <Badge colorScheme={toBadgeColor(colors[accountType] || 'gray')} className="text-[10px]">
                {accountType.toUpperCase()}
            </Badge>
        );
    };

    // Get unique categories for filter
    const uniqueCategories = [...new Set(connectorTypes.map(t => t.category))];

    if (loading && connectors.length === 0) {
        return (
            <div className="bg-gray-50 py-10 text-center">
                <Spinner size="lg" />
                <Text className="mt-4 block">Loading connectors...</Text>
            </div>
        );
    }

    if (error) {
        return (
            <div className="border border-red-200 bg-red-50 py-10 text-center">
                <Text className="text-red-600">Error: {error}</Text>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-6 flex items-center justify-between border-b border-gray-200 pb-2">
                <div>
                    <Heading as="h2" className="mb-1 text-base">Connectors by Type</Heading>
                    <Text className="text-sm text-gray-600">
                        View connectors grouped by type. Expand to see linked accounts and manage individual connectors.
                    </Text>
                </div>
                <div className="flex gap-2">
                    <Button onClick={expandAll} variant="outline" size="sm">
                        Expand All
                    </Button>
                    <Button onClick={collapseAll} variant="outline" size="sm">
                        Collapse All
                    </Button>
                    <Button onClick={fetchConnectors} variant="outline" size="sm">
                        <FiRefreshCw /> Refresh
                    </Button>
                </div>
            </div>

            {/* Filters */}
            <div className="mb-6 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                    <Text className="text-sm font-medium">Status:</Text>
                    <select
                        className="h-8 w-auto border border-gray-300 px-2 text-sm"
                        value={enabledFilter}
                        onChange={e => setEnabledFilter(e.target.value)}
                    >
                        <option value="">All</option>
                        <option value="true">Enabled Only</option>
                    </select>
                </div>
                <div className="flex items-center gap-2">
                    <Text className="text-sm font-medium">Category:</Text>
                    <select
                        className="h-8 w-auto border border-gray-300 px-2 text-sm"
                        value={categoryFilter}
                        onChange={e => setCategoryFilter(e.target.value)}
                    >
                        <option value="">All Categories</option>
                        {uniqueCategories.map(cat => (
                            <option key={cat} value={cat}>
                                {cat.toUpperCase()}
                            </option>
                        ))}
                    </select>
                </div>
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
            </div>

            {/* Connectors Table - Grouped by Type */}
            {groupedConnectors.length === 0 ? (
                <div className="border border-gray-200 bg-gray-50 p-8 text-center">
                    <Text className="mb-4 block text-gray-600">No connectors found</Text>
                    <Text className="block text-sm text-gray-500">
                        Create connectors from the Accounts tab by adding connectors to your accounts.
                    </Text>
                </div>
            ) : (
                <div className="overflow-hidden border border-gray-200 bg-white">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <th className="w-[40px] px-2 py-1 text-left"></th>
                                <th className="px-2 py-1 text-left">Connector Type</th>
                                <th className="px-2 py-1 text-left">Category</th>
                                <th className="px-2 py-1 text-left">Linked Accounts</th>
                                <th className="px-2 py-1 text-left">Enabled</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groupedConnectors.map((group) => (
                                <React.Fragment key={group.type}>
                                    {/* Connector Type Row */}
                                    <tr
                                        onClick={() => toggleExpanded(group.type)}
                                        className={`cursor-pointer hover:bg-gray-50 ${expandedTypes.has(group.type) ? 'bg-blue-50' : ''}`}
                                    >
                                        <td className="px-2 py-1">
                                            <Button
                                                aria-label="Expand"
                                                variant="ghost"
                                                className="h-6 w-6 p-0"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleExpanded(group.type);
                                                }}
                                            >
                                                {expandedTypes.has(group.type) ? <FiChevronDown /> : <FiChevronRight />}
                                            </Button>
                                        </td>
                                        <td className="px-2 py-1">
                                            <Text className="font-semibold">{group.displayName}</Text>
                                        </td>
                                        <td className="px-2 py-1">
                                            {getCategoryBadge(group.type)}
                                        </td>
                                        <td className="px-2 py-1">
                                            <div className="flex flex-wrap gap-1">
                                                {group.connectors.slice(0, 4).map(c => (
                                                    <Badge
                                                        key={c.id}
                                                        colorScheme={c.enabled ? 'green' : 'gray'}
                                                        className="text-[10px]"
                                                    >
                                                        {c.account_name}
                                                    </Badge>
                                                ))}
                                                {group.connectors.length > 4 && (
                                                    <Badge colorScheme="gray" className="text-[10px]">
                                                        +{group.connectors.length - 4} more
                                                    </Badge>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1">
                                            <Text className="text-sm text-gray-600">
                                                {group.enabledCount}/{group.totalCount}
                                            </Text>
                                        </td>
                                    </tr>

                                    {/* Expanded Account Details */}
                                    {expandedTypes.has(group.type) && group.connectors.map(connector => (
                                        <tr key={connector.id} className="bg-gray-50">
                                            <td className="px-2 py-1"></td>
                                            <td className="px-2 py-1 pl-8">
                                                <div className="flex flex-col gap-0">
                                                    <Text className="text-sm font-medium">{connector.account_name}</Text>
                                                    {getAccountTypeBadge(connector.account_type)}
                                                </div>
                                            </td>
                                            <td className="px-2 py-1">
                                                <div className="flex flex-col gap-0">
                                                    {connector.config?.chain && (
                                                        <Text className="text-xs">Chain: {connector.config.chain}</Text>
                                                    )}
                                                    {connector.config?.address && (
                                                        <Text className="block max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-500">
                                                            {connector.config.address}
                                                        </Text>
                                                    )}
                                                    {connector.config?.start_date && (
                                                        <Text className="text-xs text-gray-500">
                                                            Since: {connector.config.start_date}
                                                        </Text>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-2 py-1">
                                                <div className="flex flex-col gap-1">
                                                    {getStatusBadge(connector.last_sync_status)}
                                                    <Text className="text-xs text-gray-500">
                                                        {connector.last_sync_at
                                                            ? new Date(connector.last_sync_at).toLocaleString()
                                                            : 'Never synced'}
                                                    </Text>
                                                </div>
                                            </td>
                                            <td className="px-2 py-1">
                                                <div className="flex items-center gap-2">
                                                    <ToggleSwitch
                                                        checked={connector.enabled}
                                                        onChange={() => handleToggle(connector)}
                                                    />
                                                    <Button
                                                        aria-label="Delete"
                                                        variant="ghost"
                                                        colorScheme="red"
                                                        className="h-6 w-6 p-0"
                                                        onClick={() => handleDelete(connector)}
                                                    >
                                                        <FiTrash2 />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Summary */}
            <div className="mt-4 bg-white p-4 shadow-sm">
                <Text className="text-sm text-gray-600">
                    <strong>{groupedConnectors.length}</strong> connector type(s) •{' '}
                    <strong>{connectors.length}</strong> total connector(s)
                    {enabledFilter === 'true' && <span> • Showing enabled only</span>}
                    {categoryFilter && <span> • Category: <strong>{categoryFilter.toUpperCase()}</strong></span>}
                </Text>
            </div>

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
        </div>
    );
};

export default ConnectorsManager;
