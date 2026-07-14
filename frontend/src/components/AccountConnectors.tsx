import React, { useState, useEffect } from 'react';
import { Badge, type BadgeColorScheme, Button } from './ui/primitives';
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
                return <Badge colorScheme="green" className="text-[10px]">OK</Badge>;
            case 'failed':
                return <Badge colorScheme="red" className="text-[10px]">Fail</Badge>;
            case 'running':
                return <Badge colorScheme="blue" className="text-[10px]">Run</Badge>;
            default:
                return <Badge colorScheme="gray" className="text-[10px]">—</Badge>;
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

        const colors: Record<string, BadgeColorScheme> = {
            cex: 'blue',
            onchain: 'purple',
            broker: 'green',
        };

        return (
            <Badge colorScheme={colors[info.category] || 'gray'} className="text-[10px]">
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
        <div>
            <div className="flex flex-col items-stretch gap-2">
                {/* Connectors Table */}
                {connectors.length === 0 ? (
                    <div className="border border-slate-200 bg-slate-50 p-4 text-center">
                        <span className="mb-2 block text-xs text-slate-600">No connectors configured</span>
                        <Button size="sm" colorScheme="blue" onClick={handleCreate}>
                            <FiPlus size={10} /> Add Connector
                        </Button>
                    </div>
                ) : (
                    <>
                        <div className="flex justify-end gap-1">
                            <Button
                                aria-label="Refresh"
                                size="sm"
                                variant="ghost"
                                onClick={fetchConnectors}
                            >
                                <FiRefreshCw size={10} />
                            </Button>
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={handleCreate}
                                disabled={availableTypes.length === 0}
                            >
                                <FiPlus size={10} /> Add
                            </Button>
                        </div>
                        <div className="overflow-x-auto border border-slate-200">
                            <table className="w-full min-w-[480px] text-xs">
                                <thead>
                                    <tr>
                                        <th className="p-2 text-left text-[10px]">Connector</th>
                                        <th className="p-2 text-left text-[10px]">Config</th>
                                        <th className="p-2 text-left text-[10px]">Status</th>
                                        <th className="p-2 text-left text-[10px]">Enabled</th>
                                        <th className="p-2 text-right text-[10px]">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {connectors.map((connector) => (
                                        <tr key={connector.id} className="border-t border-slate-100">
                                            <td className="whitespace-nowrap p-2">
                                                <div className="flex flex-col items-start gap-0.5">
                                                    <span className="text-xs font-medium">
                                                        {getConnectorDisplayName(connector.connector_type)}
                                                    </span>
                                                    <div className="flex items-center gap-1">
                                                        {getCategoryBadge(connector.connector_type)}
                                                        {connector.config?.test_mode && (
                                                            <Badge
                                                                colorScheme="orange"
                                                                className="cursor-pointer text-[10px]"
                                                                onClick={(e) => { e.stopPropagation(); handleEdit(connector); }}
                                                                title="Click to manage test fixture"
                                                            >
                                                                🧪 Test
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="p-2">
                                                <div className="flex flex-col items-start gap-0">
                                                    {connector.config?.chain && (
                                                        <span className="text-[10px]">{connector.config.chain}</span>
                                                    )}
                                                    {connector.config?.address && (
                                                        <span className="max-w-[100px] truncate text-[10px] text-slate-500">
                                                            {connector.config.address}
                                                        </span>
                                                    )}
                                                    {connector.config?.wallet_address && (
                                                        <span className="max-w-[100px] truncate text-[10px] text-slate-500" title={connector.config.wallet_address}>
                                                            {connector.config.wallet_address}
                                                        </span>
                                                    )}
                                                    {connector.config?.symbols && (
                                                        <span className="text-[10px]">
                                                            {connector.config.symbols.slice(0, 3).join(', ')}
                                                            {connector.config.symbols.length > 3 && '...'}
                                                        </span>
                                                    )}
                                                    {connector.config?.start_datetime && (
                                                        <span className="text-[10px] text-slate-500">
                                                            Since: {new Date(connector.config.start_datetime).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' })}
                                                        </span>
                                                    )}
                                                    {connector.config?.default_file_name && (
                                                        <span className="max-w-[100px] truncate text-[10px] text-slate-500" title={connector.config.default_file_name}>
                                                            📁 {connector.config.default_file_name}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="p-2">
                                                <div className="flex flex-col items-start gap-0.5">
                                                    <div className="flex items-center gap-1">
                                                        {getStatusBadge(connector.last_sync_status)}
                                                        <span className="text-[10px] text-slate-500">
                                                            {connector.last_sync_at
                                                                ? formatRelativeTime(connector.last_sync_at)
                                                                : 'Never'}
                                                        </span>
                                                    </div>
                                                    {connector.last_error && (
                                                        <span className="max-w-[150px] truncate text-[10px] text-red-500" title={connector.last_error}>
                                                            {connector.last_error}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="p-2">
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={connector.enabled}
                                                    onClick={() => handleToggle(connector)}
                                                    className={`relative inline-flex h-[12px] w-[22px] items-center transition-colors ${connector.enabled ? 'bg-green-500' : 'bg-slate-300'}`}
                                                >
                                                    <span
                                                        className={`inline-block h-[10px] w-[10px] transform bg-white transition-transform ${connector.enabled ? 'translate-x-[10px]' : 'translate-x-[1px]'}`}
                                                    />
                                                </button>
                                            </td>
                                            <td className="whitespace-nowrap p-2">
                                                <div className="flex items-center justify-end gap-0.5">
                                                    <Button
                                                        aria-label="Purge data"
                                                        size="sm"
                                                        variant="ghost"
                                                        title="Purge connector data (keep config)"
                                                        onClick={() => handlePurge(connector)}
                                                    >
                                                        <LuEraser size={10} />
                                                    </Button>
                                                    <Button
                                                        aria-label="Edit"
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => handleEdit(connector)}
                                                    >
                                                        <FiEdit2 size={10} />
                                                    </Button>
                                                    <Button
                                                        aria-label="Delete"
                                                        size="sm"
                                                        variant="ghost"
                                                        colorScheme="red"
                                                        onClick={() => handleDelete(connector)}
                                                    >
                                                        <FiTrash2 size={10} />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}

                {/* Priority Note */}
                <span className="text-[10px] text-slate-500">
                    Synced by priority (lower = first)
                </span>
            </div>

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
        </div>
    );
};

export default AccountConnectors;
