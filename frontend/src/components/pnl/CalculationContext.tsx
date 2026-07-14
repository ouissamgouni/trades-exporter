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

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Spinner } from '../ui/primitives';
import { FiActivity, FiPlay, FiSave, FiRefreshCw, FiClock, FiTrash2, FiDownload, FiPlus, FiFolder } from 'react-icons/fi';
import { CalculationConfig, CalculationStatus, VersionListItem } from './types';
import { Account, CostMethod, LotMode } from '../../types';
import { formatDateTimeLocale } from '../../utils/dateUtils';

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
                return <Badge colorScheme="gray">No Calculation</Badge>;
            case 'calculating':
                return <Badge colorScheme="blue"><Spinner size="xs" className="mr-1" /> Calculating...</Badge>;
            case 'preview':
                return <Badge colorScheme="orange">Preview</Badge>;
            case 'persisted':
                return <Badge colorScheme="green">Saved</Badge>;
            case 'error':
                return <Badge colorScheme="red">Error</Badge>;
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
        <div className="mb-4 rounded-md border border-gray-200 bg-white">
            <div className="p-4">
                {/* Mode Toggle: Load Version OR New Calculation */}
                <div className="mb-4 flex gap-2 border-b border-gray-200 pb-4">
                    <Button
                        size="sm"
                        variant={mode === 'load' ? 'solid' : 'outline'}
                        colorScheme={mode === 'load' ? 'blue' : 'gray'}
                        onClick={() => onModeChange('load')}
                        className="max-w-[200px] flex-1"
                    >
                        <FiFolder style={{ marginRight: 6 }} />
                        Load Saved Version
                    </Button>
                    <Button
                        size="sm"
                        variant={mode === 'new' ? 'solid' : 'outline'}
                        colorScheme={mode === 'new' ? 'blue' : 'gray'}
                        onClick={() => onModeChange('new')}
                        className="max-w-[200px] flex-1"
                    >
                        <FiPlus style={{ marginRight: 6 }} />
                        New Calculation
                    </Button>
                    <div className="flex-1" />
                    {getStatusBadge()}
                </div>

                {/* Load Version Mode */}
                {mode === 'load' && onLoadVersion && (
                    <div>
                        <div className="mb-2 text-xs font-medium text-gray-600">
                            <FiClock style={{ display: 'inline', marginRight: 4 }} />
                            Saved Versions {availableVersions.length > 0 && `(${availableVersions.length})`}
                            {isLoadingVersions && <Spinner size="xs" className="ml-2" />}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                className="h-9 w-[320px] border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                                value={selectedVersionId ?? ''}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val) onLoadVersion(parseInt(val, 10));
                                }}
                            >
                                <option value="">Select a saved version...</option>
                                {availableVersions.map((v) => (
                                    <option key={v.version_id} value={v.version_id}>
                                        v{v.version_id} - {formatDateTimeLocale(v.created_at)} - {v.lot_method} ({v.status})
                                    </option>
                                ))}
                            </select>

                            {selectedVersionId && onDeleteVersion && (
                                <Button
                                    size="sm"
                                    colorScheme="red"
                                    variant={showDeleteConfirm === selectedVersionId ? 'solid' : 'outline'}
                                    onClick={() => handleDeleteVersion(selectedVersionId)}
                                    disabled={isDeleting}
                                >
                                    {isDeleting ? (
                                        <><Spinner size="xs" className="mr-2" /> Deleting...</>
                                    ) : showDeleteConfirm === selectedVersionId ? (
                                        <><FiTrash2 /> Click to confirm</>
                                    ) : (
                                        <><FiTrash2 /> Delete</>
                                    )}
                                </Button>
                            )}

                            {selectedVersion && (
                                <Badge colorScheme="gray" className="ml-2">
                                    {selectedVersion.lot_method} / {selectedVersion.lot_mode}
                                </Badge>
                            )}
                        </div>

                        {selectedVersion && (
                            <div className="mt-2">
                                <div className="text-xs text-gray-500">
                                    <FiClock style={{ display: 'inline', marginRight: 4 }} />
                                    Calculated: {formatDateTimeLocale(selectedVersion.created_at)}
                                </div>
                                <div className="mt-1 text-xs text-gray-500">
                                    Base: {selectedVersion.base_currency_symbol || '?'} ·
                                    Tolerance: {selectedVersion.residual_tolerance_pct === 0 ? 'OFF' : `${selectedVersion.residual_tolerance_pct}%`} ·
                                    Neg. balances: {selectedVersion.allow_negative_balances ? '✓' : '✗'} ·
                                    Swaps taxable: {selectedVersion.crypto_swap_taxable ? '✓' : '✗'} ·
                                    Fees taxable: {selectedVersion.fee_taxable ? '✓' : '✗'}
                                    {selectedVersion.use_price_fallback !== undefined && (
                                        <> · Price fallback: {selectedVersion.use_price_fallback ? `✓ (${selectedVersion.price_staleness_window_days ?? 7}d)` : '✗'}</>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* New Calculation Mode */}
                {mode === 'new' && (
                    <>
                        {/* Accounts Filter Section - Prominent, Above Other Config */}
                        <div className="mb-4 border-b border-gray-100 pb-4">
                            <div className="mb-2 text-xs font-medium text-gray-600">
                                Filter by Accounts
                            </div>
                            <div className="max-h-[180px] overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-2">
                                <div className="flex flex-wrap gap-1">
                                    {isLoadingAccounts ? (
                                        <span className="text-sm text-gray-400">Loading accounts...</span>
                                    ) : accounts.length === 0 ? (
                                        <span className="text-sm text-gray-400">No accounts available</span>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant={!config.account_ids || config.account_ids.length === 0 ? 'solid' : 'outline'}
                                                colorScheme={!config.account_ids || config.account_ids.length === 0 ? 'blue' : 'gray'}
                                                onClick={() => onConfigChange({ account_ids: [] })}
                                            >
                                                All ({accounts.length})
                                            </Button>
                                            {accounts.map(account => (
                                                <Button
                                                    key={account.id}
                                                    size="sm"
                                                    variant={config.account_ids?.includes(account.id) ? 'solid' : 'outline'}
                                                    colorScheme={config.account_ids?.includes(account.id) ? 'blue' : 'gray'}
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
                                </div>
                            </div>
                            {config.account_ids && config.account_ids.length > 0 && (
                                <div className="mt-1 text-xs text-blue-600">
                                    {config.account_ids.length} account{config.account_ids.length > 1 ? 's' : ''} selected
                                </div>
                            )}
                        </div>

                        {/* Main Configuration Parameters */}
                        <div className="mb-4 flex flex-wrap items-start gap-4">
                            <div>
                                <div className="mb-1 text-xs font-medium text-gray-600">
                                    Cost Method
                                </div>
                                <select
                                    className="h-9 w-[100px] border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    value={config.lot_method}
                                    onChange={(e) => onConfigChange({ lot_method: e.target.value as CostMethod })}
                                >
                                    <option value="FIFO">FIFO</option>
                                    <option value="LIFO">LIFO</option>
                                    <option value="HIFO">HIFO</option>
                                </select>
                            </div>

                            <div>
                                <div className="mb-1 text-xs font-medium text-gray-600">
                                    Lot Mode
                                </div>
                                <select
                                    className="h-9 w-[130px] border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    value={config.lot_mode}
                                    onChange={(e) => onConfigChange({ lot_mode: e.target.value as LotMode })}
                                >
                                    <option value="LOT_TRAVEL">Lot Travel</option>
                                    <option value="MEGA_WALLET">Mega Wallet</option>
                                </select>
                            </div>

                            <div>
                                <div className="mb-1 text-xs font-medium text-gray-600">
                                    Base Currency
                                </div>
                                <Badge colorScheme="blue" className="px-3 py-1 text-base">
                                    {config.base_currency_symbol}
                                </Badge>
                            </div>

                            {/* Advanced Settings - Inline */}
                            <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
                                <div className="mb-2 text-xs font-semibold text-gray-700">
                                    Advanced Settings
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-gray-600">Residual %</span>
                                        <input
                                            type="number"
                                            value={config.residual_tolerance_pct}
                                            onChange={(e) => onConfigChange({ residual_tolerance_pct: parseFloat(e.target.value) || 0 })}
                                            step={0.01}
                                            min={0}
                                            max={100}
                                            style={{
                                                width: '60px',
                                                padding: '4px 6px',
                                                borderRadius: '4px',
                                                border: '1px solid #e2e8f0',
                                                fontSize: '12px',
                                            }}
                                        />
                                    </div>

                                    <div className="flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            id="allow_negative_balances"
                                            checked={config.allow_negative_balances}
                                            onChange={(e) => onConfigChange({ allow_negative_balances: e.target.checked })}
                                            style={{ width: '14px', height: '14px' }}
                                        />
                                        <label htmlFor="allow_negative_balances" style={{ fontSize: '0.75rem', color: '#718096', cursor: 'pointer' }}>
                                            Negative Bal.
                                        </label>
                                    </div>

                                    <div className="flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            id="compute_residuals"
                                            checked={config.compute_residuals}
                                            onChange={(e) => onConfigChange({ compute_residuals: e.target.checked })}
                                            style={{ width: '14px', height: '14px' }}
                                        />
                                        <label htmlFor="compute_residuals" style={{ fontSize: '0.75rem', color: '#718096', cursor: 'pointer' }}>
                                            Residuals
                                        </label>
                                    </div>

                                    <div className="flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            id="crypto_swap_taxable"
                                            checked={config.crypto_swap_taxable_by_default}
                                            onChange={(e) => onConfigChange({ crypto_swap_taxable_by_default: e.target.checked })}
                                            style={{ width: '14px', height: '14px' }}
                                        />
                                        <label htmlFor="crypto_swap_taxable" style={{ fontSize: '0.75rem', color: '#718096', cursor: 'pointer' }}>
                                            Swaps Tax
                                        </label>
                                    </div>

                                    <div className="flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            id="fee_taxable"
                                            checked={config.fee_taxable_by_default}
                                            onChange={(e) => onConfigChange({ fee_taxable_by_default: e.target.checked })}
                                            style={{ width: '14px', height: '14px' }}
                                        />
                                        <label htmlFor="fee_taxable" style={{ fontSize: '0.75rem', color: '#718096', cursor: 'pointer' }}>
                                            Fees Tax
                                        </label>
                                    </div>

                                    <div className="ml-1 border-l border-gray-300 pl-3">
                                        <div className="flex items-center gap-1">
                                            <input
                                                type="checkbox"
                                                id="use_price_fallback"
                                                checked={config.use_price_fallback}
                                                onChange={(e) => onConfigChange({ use_price_fallback: e.target.checked })}
                                                style={{ width: '14px', height: '14px' }}
                                            />
                                            <label htmlFor="use_price_fallback" style={{ fontSize: '0.75rem', color: '#718096', cursor: 'pointer' }}>
                                                Price Fallback
                                            </label>
                                        </div>
                                    </div>

                                    {config.use_price_fallback && (
                                        <div className="flex items-center gap-1">
                                            <span className="text-xs text-gray-600">Stale after</span>
                                            <input
                                                type="number"
                                                value={config.price_staleness_window_days}
                                                onChange={(e) => onConfigChange({ price_staleness_window_days: parseInt(e.target.value) || 7 })}
                                                min={1}
                                                max={365}
                                                style={{
                                                    width: '50px',
                                                    padding: '4px 6px',
                                                    borderRadius: '4px',
                                                    border: '1px solid #e2e8f0',
                                                    fontSize: '12px',
                                                }}
                                            />
                                            <span className="text-xs text-gray-600">days</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Calculate Button + Data Health Check */}
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={onCalculate}
                                disabled={isCalculating}
                            >
                                {isCalculating ? (
                                    <><Spinner size="xs" className="mr-2" /> Calculating...</>
                                ) : status === 'preview' ? (
                                    <><FiRefreshCw style={{ marginRight: 6 }} /> Recalculate</>
                                ) : (
                                    <><FiPlay style={{ marginRight: 6 }} /> Calculate</>
                                )}
                            </Button>

                            {status === 'preview' && onPersist && (
                                <Button
                                    size="sm"
                                    colorScheme="green"
                                    onClick={onPersist}
                                    disabled={isPersisting}
                                >
                                    {isPersisting ? (
                                        <><Spinner size="xs" className="mr-2" /> Saving...</>
                                    ) : (
                                        <><FiSave style={{ marginRight: 6 }} /> Save Version</>
                                    )}
                                </Button>
                            )}
                        </div>

                        {/* Config summary for draft/preview calculations */}
                        {(status === 'preview' || status === 'persisted') && (
                            <div className="mt-3 text-xs text-gray-500">
                                {config.lot_method} / {config.lot_mode} · Base: {config.base_currency_symbol || '?'} ·{' '}
                                Tolerance: {config.residual_tolerance_pct === 0 ? 'OFF' : `${config.residual_tolerance_pct}%`} ·{' '}
                                Neg. balances: {config.allow_negative_balances ? '✓' : '✗'} ·{' '}
                                Swaps taxable: {config.crypto_swap_taxable_by_default ? '✓' : '✗'} ·{' '}
                                Fees taxable: {config.fee_taxable_by_default ? '✓' : '✗'}
                                {config.use_price_fallback !== undefined && (
                                    <> · Price fallback: {config.use_price_fallback ? `✓ (${config.price_staleness_window_days ?? 7}d)` : '✗'}</>
                                )}
                            </div>
                        )}
                    </>
                )}

                {error && (
                    <div className="mt-4 rounded-md bg-red-50 p-2">
                        <div className="text-sm text-red-600">❌ {error}</div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CalculationContext;
