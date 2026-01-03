/**
 * P&L Calculation Context
 * 
 * Manages calculation state, configuration, and versioning.
 * Shows status (preview/persisted) and provides actions.
 * 
 * Two modes:
 * - "load": Select and view a saved version
 * - "new": Configure and calculate a new P&L
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Heading,
    NativeSelect,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiPlay, FiSave, FiRefreshCw, FiClock, FiTrash2, FiDownload, FiPlus, FiFolder } from 'react-icons/fi';
import { CalculationConfig, CalculationStatus, VersionListItem } from './types';
import { Account, CostMethod, LotMode } from '../../types';

export type CalculationMode = 'load' | 'new';

interface CalculationContextProps {
    status: CalculationStatus;
    config: CalculationConfig;
    onConfigChange: (config: Partial<CalculationConfig>) => void;
    onCalculate: () => void;
    // Mode: load existing version OR configure new calculation
    mode: CalculationMode;
    onModeChange: (mode: CalculationMode) => void;
    // Account filter
    accounts?: Account[];
    isLoadingAccounts?: boolean;
    // Version management - uses lightweight VersionListItem for list
    availableVersions?: VersionListItem[];
    isLoadingVersions?: boolean;
    selectedVersionId?: number;
    onLoadVersion?: (versionId: number) => void;
    onPersist?: () => void;
    onDeleteVersion?: (versionId: number) => void;
    // Loading states
    isCalculating: boolean;
    isPersisting?: boolean;
    isDeleting?: boolean;
    error?: string | null;
}

export const CalculationContext: React.FC<CalculationContextProps> = ({
    status,
    config,
    onConfigChange,
    onCalculate,
    mode,
    onModeChange,
    accounts = [],
    isLoadingAccounts = false,
    availableVersions = [],
    isLoadingVersions = false,
    selectedVersionId,
    onLoadVersion,
    onPersist,
    onDeleteVersion,
    isCalculating,
    isPersisting = false,
    isDeleting = false,
    error,
}) => {
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null);

    const selectedVersion = availableVersions.find(v => v.version_id === selectedVersionId);

    const getStatusBadge = () => {
        switch (status) {
            case 'idle':
                return <Badge colorPalette="gray">No Calculation</Badge>;
            case 'calculating':
                return <Badge colorPalette="blue"><Spinner size="xs" mr={1} /> Calculating...</Badge>;
            case 'preview':
                return <Badge colorPalette="orange">Preview</Badge>;
            case 'persisted':
                return <Badge colorPalette="green">Saved</Badge>;
            case 'error':
                return <Badge colorPalette="red">Error</Badge>;
            default:
                return null;
        }
    };

    const handleDeleteVersion = (versionId: number) => {
        if (showDeleteConfirm === versionId) {
            onDeleteVersion?.(versionId);
            setShowDeleteConfirm(null);
        } else {
            setShowDeleteConfirm(versionId);
            // Auto-cancel after 3 seconds
            setTimeout(() => setShowDeleteConfirm(null), 3000);
        }
    };

    return (
        <Card.Root mb={4}>
            <Card.Body>
                {/* Mode Toggle: Load Version OR New Calculation */}
                <Flex gap={2} mb={4} pb={4} borderBottom="1px solid" borderColor="gray.200">
                    <Button
                        size="sm"
                        variant={mode === 'load' ? 'solid' : 'outline'}
                        colorPalette={mode === 'load' ? 'blue' : 'gray'}
                        onClick={() => onModeChange('load')}
                        flex={1}
                        maxW="200px"
                    >
                        <FiFolder style={{ marginRight: 6 }} />
                        Load Saved Version
                    </Button>
                    <Button
                        size="sm"
                        variant={mode === 'new' ? 'solid' : 'outline'}
                        colorPalette={mode === 'new' ? 'blue' : 'gray'}
                        onClick={() => onModeChange('new')}
                        flex={1}
                        maxW="200px"
                    >
                        <FiPlus style={{ marginRight: 6 }} />
                        New Calculation
                    </Button>
                    <Box flex={1} />
                    {getStatusBadge()}
                </Flex>

                {/* Load Version Mode */}
                {mode === 'load' && onLoadVersion && (
                    <Box>
                        <Text fontSize="xs" fontWeight="medium" color="gray.600" mb={2}>
                            <FiClock style={{ display: 'inline', marginRight: 4 }} />
                            Saved Versions {availableVersions.length > 0 && `(${availableVersions.length})`}
                            {isLoadingVersions && <Spinner size="xs" ml={2} />}
                        </Text>
                        <Flex gap={2} align="center" wrap="wrap">
                            <NativeSelect.Root size="sm" width="320px">
                                <NativeSelect.Field
                                    value={selectedVersionId ?? ''}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val) onLoadVersion(parseInt(val, 10));
                                    }}
                                    _disabled={{ opacity: 0.5 }}
                                >
                                    <option value="">Select a saved version...</option>
                                    {availableVersions.map((v) => (
                                        <option key={v.version_id} value={v.version_id}>
                                            v{v.version_id} - {new Date(v.created_at ?? '').toLocaleString()} - {v.lot_method} ({v.status})
                                        </option>
                                    ))}
                                </NativeSelect.Field>
                            </NativeSelect.Root>

                            {selectedVersionId && onDeleteVersion && (
                                <Button
                                    size="sm"
                                    colorPalette="red"
                                    variant={showDeleteConfirm === selectedVersionId ? 'solid' : 'outline'}
                                    onClick={() => handleDeleteVersion(selectedVersionId)}
                                    disabled={isDeleting}
                                >
                                    {isDeleting ? (
                                        <><Spinner size="xs" mr={2} /> Deleting...</>
                                    ) : showDeleteConfirm === selectedVersionId ? (
                                        <><FiTrash2 /> Click to confirm</>
                                    ) : (
                                        <><FiTrash2 /> Delete</>
                                    )}
                                </Button>
                            )}

                            {selectedVersion && (
                                <Badge colorPalette="gray" ml={2}>
                                    {selectedVersion.lot_method} / {selectedVersion.lot_mode}
                                </Badge>
                            )}
                        </Flex>

                        {selectedVersion && (
                            <Text fontSize="xs" color="gray.500" mt={2}>
                                <FiClock style={{ display: 'inline', marginRight: 4 }} />
                                Calculated: {selectedVersion.created_at ? new Date(selectedVersion.created_at).toLocaleString() : 'Unknown'}
                            </Text>
                        )}
                    </Box>
                )}

                {/* New Calculation Mode */}
                {mode === 'new' && (
                    <>
                        {/* Accounts Filter Section - Prominent, Above Other Config */}
                        <Box mb={4} pb={4} borderBottom="1px solid" borderColor="gray.100">
                            <Text fontSize="xs" fontWeight="medium" color="gray.600" mb={2}>
                                Filter by Accounts
                            </Text>
                            <Box
                                maxH="180px"
                                overflowY="auto"
                                p={2}
                                bg="gray.50"
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.200"
                            >
                                <Flex gap={1} flexWrap="wrap">
                                    {isLoadingAccounts ? (
                                        <Text fontSize="sm" color="gray.400">Loading accounts...</Text>
                                    ) : accounts.length === 0 ? (
                                        <Text fontSize="sm" color="gray.400">No accounts available</Text>
                                    ) : (
                                        <>
                                            <Button
                                                size="xs"
                                                variant={!config.account_ids || config.account_ids.length === 0 ? 'solid' : 'outline'}
                                                colorPalette={!config.account_ids || config.account_ids.length === 0 ? 'blue' : 'gray'}
                                                onClick={() => onConfigChange({ account_ids: [] })}
                                            >
                                                All ({accounts.length})
                                            </Button>
                                            {accounts.map(account => (
                                                <Button
                                                    key={account.id}
                                                    size="xs"
                                                    variant={config.account_ids?.includes(account.id) ? 'solid' : 'outline'}
                                                    colorPalette={config.account_ids?.includes(account.id) ? 'blue' : 'gray'}
                                                    onClick={() => {
                                                        const current = config.account_ids || [];
                                                        const newIds = current.includes(account.id)
                                                            ? current.filter(id => id !== account.id)
                                                            : [...current, account.id];
                                                        onConfigChange({ account_ids: newIds });
                                                    }}
                                                >
                                                    {account.name}
                                                </Button>
                                            ))}
                                        </>
                                    )}
                                </Flex>
                            </Box>
                            {config.account_ids && config.account_ids.length > 0 && (
                                <Text fontSize="xs" color="blue.600" mt={1}>
                                    {config.account_ids.length} account{config.account_ids.length > 1 ? 's' : ''} selected
                                </Text>
                            )}
                        </Box>

                        {/* Other Configuration Parameters */}
                        <Flex gap={4} wrap="wrap" align="flex-end" mb={4}>
                            <Box>
                                <Text fontSize="xs" mb={1} fontWeight="medium" color="gray.600">
                                    Cost Method
                                </Text>
                                <NativeSelect.Root size="sm" width="100px">
                                    <NativeSelect.Field
                                        value={config.lot_method}
                                        onChange={(e) => onConfigChange({ lot_method: e.target.value as CostMethod })}
                                    >
                                        <option value="FIFO">FIFO</option>
                                        <option value="LIFO">LIFO</option>
                                        <option value="HIFO">HIFO</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Box>

                            <Box>
                                <Text fontSize="xs" mb={1} fontWeight="medium" color="gray.600">
                                    Lot Mode
                                </Text>
                                <NativeSelect.Root size="sm" width="130px">
                                    <NativeSelect.Field
                                        value={config.lot_mode}
                                        onChange={(e) => onConfigChange({ lot_mode: e.target.value as LotMode })}
                                    >
                                        <option value="LOT_TRAVEL">Lot Travel</option>
                                        <option value="MEGA_WALLET">Mega Wallet</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Box>

                            <Box>
                                <Text fontSize="xs" mb={1} fontWeight="medium" color="gray.600">
                                    Base Currency
                                </Text>
                                <Badge colorPalette="blue" size="lg" px={3} py={1}>
                                    {config.base_currency_symbol}
                                </Badge>
                            </Box>

                            <Box>
                                <Text fontSize="xs" mb={1} fontWeight="medium" color="gray.600">
                                    Residual Tolerance %
                                </Text>
                                <input
                                    type="number"
                                    value={config.residual_tolerance_pct}
                                    onChange={(e) => onConfigChange({ residual_tolerance_pct: parseFloat(e.target.value) || 0 })}
                                    step={0.01}
                                    min={0}
                                    max={100}
                                    style={{
                                        width: '80px',
                                        padding: '6px 8px',
                                        borderRadius: '6px',
                                        border: '1px solid #e2e8f0',
                                        fontSize: '14px',
                                    }}
                                />
                            </Box>

                            <Box>
                                <Text fontSize="xs" mb={1} fontWeight="medium" color="gray.600">
                                    Allow Negative Balances
                                </Text>
                                <input
                                    type="checkbox"
                                    checked={config.allow_negative_balances}
                                    onChange={(e) => onConfigChange({ allow_negative_balances: e.target.checked })}
                                    style={{ width: '20px', height: '20px' }}
                                />
                            </Box>
                        </Flex>

                        {/* Calculate Button */}
                        <Flex gap={2}>
                            <Button
                                size="sm"
                                colorPalette="blue"
                                onClick={onCalculate}
                                disabled={isCalculating}
                            >
                                {isCalculating ? (
                                    <><Spinner size="xs" mr={2} /> Calculating...</>
                                ) : status === 'preview' ? (
                                    <><FiRefreshCw style={{ marginRight: 6 }} /> Recalculate</>
                                ) : (
                                    <><FiPlay style={{ marginRight: 6 }} /> Calculate</>
                                )}
                            </Button>

                            {status === 'preview' && onPersist && (
                                <Button
                                    size="sm"
                                    colorPalette="green"
                                    onClick={onPersist}
                                    disabled={isPersisting}
                                >
                                    {isPersisting ? (
                                        <><Spinner size="xs" mr={2} /> Saving...</>
                                    ) : (
                                        <><FiSave style={{ marginRight: 6 }} /> Save Version</>
                                    )}
                                </Button>
                            )}
                        </Flex>
                    </>
                )}

                {error && (
                    <Box bg="red.50" p={2} borderRadius="md" mt={4}>
                        <Text color="red.600" fontSize="sm">❌ {error}</Text>
                    </Box>
                )}
            </Card.Body>
        </Card.Root>
    );
};

export default CalculationContext;
