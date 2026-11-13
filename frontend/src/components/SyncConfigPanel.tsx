import { Badge, Button, Input, Spinner, type BadgeColorScheme } from './ui/primitives';
import { Tooltip } from './ui/tooltip';
import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LuRotateCcw, LuX, LuChevronRight, LuChevronDown, LuPlus, LuEye, LuTrash2, LuUpload } from 'react-icons/lu';
import { FiPieChart } from 'react-icons/fi';
import {
    API_URL,
    ConnectorOverride,
    EnabledConnector,
    AccountSummary,
    AllConnectorsResponse,
} from '../types';
import { ConnectorFileUpload } from './ConnectorFileUpload';
import { ConnectorJobSnippet } from './ConnectorJobSnippet';
import { JobDetailDrawer } from './JobDetailDrawer';
import { BalanceDrawer } from './BalanceDrawer';
import { ConnectorPickerModal } from './ConnectorPickerModal';
import { useSyncConfigStore } from '../hooks/useSyncConfigStore';
import { formatAddress, formatChainName } from '../utils/addressUtils';
import { describeSyncWindow } from '../utils/syncWindow';

interface SyncConfigPanelProps {
    onOverridesChange: (overrides: ConnectorOverride[]) => void;
    onConfigDataChange?: (connectors: EnabledConnector[], accounts: AccountSummary[]) => void;
    disabled?: boolean;
}

const SECTION_COLORS: Record<string, { bg: string; hoverBg: string }> = {
    blue: { bg: 'bg-blue-50', hoverBg: 'hover:bg-blue-100' },
    cyan: { bg: 'bg-cyan-50', hoverBg: 'hover:bg-cyan-100' },
    purple: { bg: 'bg-purple-50', hoverBg: 'hover:bg-purple-100' },
    green: { bg: 'bg-green-50', hoverBg: 'hover:bg-green-100' },
    teal: { bg: 'bg-teal-50', hoverBg: 'hover:bg-teal-100' },
    orange: { bg: 'bg-orange-50', hoverBg: 'hover:bg-orange-100' },
};

// Format datetime for input
const formatForInput = (isoString: string | null | undefined): string => {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        return date.toISOString().slice(0, 16);
    } catch {
        return '';
    }
};

// Format datetime for display
const formatDateTime = (isoString: string | null | undefined): string => {
    if (!isoString) return 'None';
    try {
        const date = new Date(isoString);
        return date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return isoString;
    }
};

// Comma-separated input component that handles typing properly
const CommaSeparatedInput: React.FC<{
    value: string[] | null;
    onChange: (values: string[] | null) => void;
    placeholder?: string;
    disabled?: boolean;
    uppercase?: boolean;
}> = ({ value, onChange, placeholder, disabled, uppercase }) => {
    const [localValue, setLocalValue] = React.useState(value?.join(', ') ?? '');

    // Sync local value when external value changes
    React.useEffect(() => {
        setLocalValue(value?.join(', ') ?? '');
    }, [value]);

    const handleBlur = () => {
        const trimmed = localValue.trim();
        if (!trimmed) {
            onChange(null);
        } else {
            let items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
            if (uppercase) {
                items = items.map(s => s.toUpperCase());
            }
            onChange(items.length > 0 ? items : null);
        }
    };

    return (
        <Input
            type="text"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            placeholder={placeholder}
            disabled={disabled}
            className="h-7 flex-1 text-xs"
        />
    );
};

// Account Card component - one card per account with connector list inside
const AccountCard: React.FC<{
    account: AccountSummary;
    connectors: EnabledConnector[];
    overrides: Map<number, ConnectorOverride>;
    accountOverride?: boolean;
    getEffectiveEnabled: (connector: EnabledConnector) => boolean;
    onAccountToggle: (enabled: boolean) => void;
    onConnectorEnabledChange: (connectorId: number, enabled: boolean, defaultEnabled: boolean) => void;
    onTestModeChange: (connectorId: number, testMode: boolean, defaultTestMode: boolean) => void;
    onTestFileUpload: (connectorId: number, file: File) => void;
    onTestFileRemove: (connectorId: number) => void;
    testFixtures: Map<number, { filename: string; path: string; itemCount: number }>;
    fixtureUploading: number | null;
    onPreviewFixture: (connectorId: number) => void;
    onSinceChange: (connectorId: number, since: string | null, defaultSince: string | null) => void;
    onSinceReset: (connectorId: number) => void;
    onSinceClear: (connectorId: number) => void;
    onSymbolsChange: (connectorId: number, symbols: string[] | null) => void;
    onCurrenciesChange: (connectorId: number, currencies: string[] | null) => void;
    onFileUploadComplete: (connectorId: number) => void;
    onJobSnippetClick: (connector: EnabledConnector) => void;
    onBalanceClick: (accountId: number) => void;
    onRemove?: () => void;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    disabled?: boolean;
}> = ({
    account,
    connectors,
    overrides,
    accountOverride,
    getEffectiveEnabled,
    onAccountToggle,
    onConnectorEnabledChange,
    onTestModeChange,
    onTestFileUpload,
    onTestFileRemove,
    testFixtures,
    fixtureUploading,
    onPreviewFixture,
    onSinceChange,
    onSinceReset,
    onSinceClear,
    onSymbolsChange,
    onCurrenciesChange,
    onFileUploadComplete,
    onJobSnippetClick,
    onBalanceClick,
    onRemove,
    isCollapsed,
    onToggleCollapse,
    disabled,
}) => {
        const enabledCount = connectors.filter(c => getEffectiveEnabled(c)).length;
        const hasOverride = accountOverride !== undefined || connectors.some(c => overrides.has(c.connector_id));
        const allEnabled = enabledCount === connectors.length;
        const accountDisabled = enabledCount === 0;  // Check if no connectors are enabled

        // If collapsed, show minimal horizontal card
        if (isCollapsed) {
            return (
                <div
                    onClick={onToggleCollapse}
                    className="w-[140px] flex-shrink-0 cursor-pointer border border-slate-200 bg-slate-50 opacity-70 transition-all hover:border-slate-300 hover:opacity-100"
                >
                    <div className="px-3 py-2">
                        <div className="flex flex-col items-center gap-1">
                            <LuChevronRight size={16} color="gray" />
                            <p className="text-center text-xs font-medium leading-tight text-slate-600">
                                {account.name}
                            </p>
                            <Badge colorScheme="gray">
                                {connectors.length}
                            </Badge>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div
                className={`w-full min-w-0 border ${hasOverride ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-white'} ${accountDisabled && !allEnabled ? 'opacity-80' : 'opacity-100'}`}
            >
                <div className="px-3 pb-2 pt-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <button
                                type="button"
                                aria-label="Toggle account details"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleCollapse();
                                }}
                                className="flex-shrink-0 text-slate-400 hover:text-slate-600"
                            >
                                <LuChevronDown size={14} />
                            </button>
                            <div className="flex min-w-0 flex-col items-start gap-0">
                                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-semibold text-slate-700">
                                        {account.name}
                                    </span>
                                    <Badge colorScheme={account.account_type === 'exchange' ? 'purple' : 'green'}>
                                        {account.account_type}
                                    </Badge>
                                    {account.group && (
                                        <Badge colorScheme="blue" className="border border-blue-300 bg-transparent text-blue-600">
                                            {account.group}
                                        </Badge>
                                    )}
                                </div>
                                {account.address_or_identifier && (
                                    <span className="font-mono text-xs text-slate-500">
                                        {formatAddress(account.address_or_identifier)}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                            {onRemove && (
                                <Tooltip content="Remove from sync config" openDelay={300}>
                                    <Button
                                        aria-label="Remove from sync config"
                                        size="sm"
                                        variant="ghost"
                                        colorScheme="red"
                                        className="h-6 w-6 p-0"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove();
                                        }}
                                    >
                                        <LuX size={13} />
                                    </Button>
                                </Tooltip>
                            )}
                            <Tooltip content="View live balance" openDelay={300}>
                                <Button
                                    aria-label="View balance"
                                    size="sm"
                                    variant="ghost"
                                    colorScheme="green"
                                    className="h-6 w-6 p-0"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onBalanceClick(account.id);
                                    }}
                                >
                                    <FiPieChart size={13} />
                                </Button>
                            </Tooltip>
                            <span className="text-xs text-slate-500">
                                {enabledCount}/{connectors.length}
                            </span>
                            <Tooltip
                                content={(() => {
                                    if (allEnabled) {
                                        return "Click to disable all connectors for this account";
                                    }
                                    if (enabledCount > 0) {
                                        return `${enabledCount} of ${connectors.length} enabled - Click to enable all`;
                                    }
                                    return "Click to enable all connectors for this account";
                                })()}
                                openDelay={300}
                            >
                                <span className="inline-flex">
                                    <input
                                        type="checkbox"
                                        title="Toggle all connectors for this account"
                                        checked={allEnabled}
                                        ref={(el) => { if (el) el.indeterminate = enabledCount > 0 && !allEnabled; }}
                                        disabled={disabled}
                                        onChange={(e) => {
                                            const isMixed = enabledCount > 0 && !allEnabled;
                                            onAccountToggle(isMixed ? true : e.target.checked);
                                        }}
                                        className="h-4 w-4 cursor-pointer accent-blue-500"
                                    />
                                </span>
                            </Tooltip>
                        </div>
                    </div>
                </div>
                <div className="px-3 pb-3 pt-0">
                    <div className="flex flex-col gap-2">
                        {connectors.map((connector) => {
                            const override = overrides.get(connector.connector_id);
                            const isEnabled = getEffectiveEnabled(connector);
                            const isTestMode = override?.test_mode ?? connector.test_mode;
                            const hasEnabledOverride = override?.enabled !== undefined || accountOverride !== undefined;
                            const hasTestModeOverride = override?.test_mode !== undefined;
                            const defaultEnabled = connector.enabled && (connector.account_enabled ?? true);

                            // Since datetime handling
                            const supportsIncremental = connector.supports_incremental_sync ?? false;
                            const defaultSince = connector.default_since_datetime ?? connector.start_datetime ?? null;
                            const currentSince = override?.since_datetime !== undefined
                                ? override.since_datetime
                                : defaultSince;
                            const hasSinceOverride = override?.since_datetime !== undefined;
                            const isFullSync = currentSince === null || currentSince === '';

                            // Symbols/Currencies handling
                            const optionalConfig = connector.optional_config || [];
                            const supportsSymbols = optionalConfig.includes('symbols');
                            const supportsCurrencies = optionalConfig.includes('currencies');
                            const hasSymbolsOverride = override?.symbols !== undefined;
                            const hasCurrenciesOverride = override?.currencies !== undefined;
                            const currentSymbols = override?.symbols ?? null;
                            const currentCurrencies = override?.currencies ?? null;

                            const hasAnyOverride = hasEnabledOverride || hasTestModeOverride || hasSinceOverride || hasSymbolsOverride || hasCurrenciesOverride;

                            return (
                                <div
                                    key={connector.connector_id}
                                    className={`px-2 py-2 ${hasAnyOverride ? 'border border-orange-200 bg-orange-50' : 'border-0'}`}
                                >
                                    {/* Row 1: Checkbox, Name, Test toggle */}
                                    <div className="flex items-center justify-between">
                                        <label className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={isEnabled}
                                                disabled={disabled}
                                                onChange={(e) =>
                                                    onConnectorEnabledChange(connector.connector_id, e.target.checked, defaultEnabled)
                                                }
                                                className="h-4 w-4 cursor-pointer accent-blue-500"
                                            />
                                            <div className="flex flex-col items-start gap-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span className={`text-sm ${isEnabled ? 'text-slate-700' : 'text-slate-400 line-through'}`}>
                                                        {connector.display_name || connector.connector_type}
                                                    </span>
                                                    {connector.is_file_connector && (
                                                        <Badge colorScheme="blue">📁 File</Badge>
                                                    )}
                                                    {connector.is_file_connector && connector.config?.default_file_name && (
                                                        <Badge colorScheme="green">📌 default</Badge>
                                                    )}
                                                    {connector.chain_name && (
                                                        <Badge colorScheme="purple">
                                                            {formatChainName(connector.chain_name)}
                                                        </Badge>
                                                    )}
                                                </div>
                                                {connector.wallet_address && (
                                                    <span className="font-mono text-xs text-slate-500">
                                                        {formatAddress(connector.wallet_address)}
                                                    </span>
                                                )}
                                            </div>
                                        </label>
                                        <div className="flex items-center gap-1.5">
                                            {hasTestModeOverride && (
                                                <Badge colorScheme="purple">🧪</Badge>
                                            )}
                                            <span className="text-[10px] text-slate-400">Test</span>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={isTestMode}
                                                aria-label="Toggle test mode"
                                                disabled={disabled || !isEnabled}
                                                onClick={() =>
                                                    onTestModeChange(connector.connector_id, !isTestMode, connector.test_mode)
                                                }
                                                className={`relative inline-flex h-[14px] w-[26px] items-center transition-colors disabled:opacity-50 ${isTestMode ? 'bg-blue-500' : 'bg-slate-300'}`}
                                            >
                                                <span
                                                    className={`inline-block h-[10px] w-[10px] transform bg-white transition-transform ${isTestMode ? 'translate-x-[14px]' : 'translate-x-[2px]'}`}
                                                />
                                            </button>
                                        </div>
                                    </div>

                                    {/* Row 1b: Test fixture upload/display (when test mode is on) */}
                                    {isTestMode && isEnabled && (() => {
                                        const fixture = testFixtures.get(connector.connector_id);
                                        const isUploading = fixtureUploading === connector.connector_id;
                                        return (
                                            <div className="mt-2 flex items-center gap-2 pl-6">
                                                {fixture ? (
                                                    <>
                                                        <Badge colorScheme="orange">
                                                            🧪 {fixture.itemCount} items
                                                        </Badge>
                                                        <span className="max-w-[100px] truncate text-[10px] text-orange-700" title={fixture.filename}>
                                                            {fixture.filename}
                                                        </span>
                                                        <Button
                                                            aria-label="Preview fixture"
                                                            size="sm"
                                                            variant="ghost"
                                                            colorScheme="blue"
                                                            className="h-6 w-6 p-0"
                                                            onClick={() => onPreviewFixture(connector.connector_id)}
                                                            title="Preview fixture content"
                                                        >
                                                            <LuEye size={12} />
                                                        </Button>
                                                        <Button
                                                            aria-label="Remove fixture"
                                                            size="sm"
                                                            variant="ghost"
                                                            colorScheme="red"
                                                            className="h-6 w-6 p-0"
                                                            onClick={() => onTestFileRemove(connector.connector_id)}
                                                            disabled={isUploading}
                                                            title="Remove test fixture"
                                                        >
                                                            <LuTrash2 size={12} />
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span className="text-[10px] text-orange-600">Fixture:</span>
                                                        {isUploading ? (
                                                            <Spinner size="xs" />
                                                        ) : (
                                                            <>
                                                                <input
                                                                    type="file"
                                                                    accept=".json"
                                                                    style={{ display: 'none' }}
                                                                    id={`fixture-input-${connector.connector_id}`}
                                                                    onChange={(e) => {
                                                                        const file = e.target.files?.[0];
                                                                        if (file) onTestFileUpload(connector.connector_id, file);
                                                                        e.target.value = '';
                                                                    }}
                                                                />
                                                                <label htmlFor={`fixture-input-${connector.connector_id}`}>
                                                                    <span
                                                                        className="inline-flex cursor-pointer items-center gap-1 border border-orange-300 px-2 py-1 text-xs text-orange-600 hover:bg-orange-50"
                                                                    >
                                                                        <LuUpload size={10} />
                                                                        Upload JSON
                                                                    </span>
                                                                </label>
                                                            </>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })()}

                                    {/* Row 2: Since datetime picker (only for incremental sync connectors when enabled) */}
                                    {supportsIncremental && isEnabled && !isTestMode && (
                                        <div className="mt-2 flex items-center gap-2 pl-6">
                                            <span className="min-w-[35px] text-xs text-slate-500">Since:</span>
                                            <Input
                                                type="datetime-local"
                                                value={formatForInput(currentSince)}
                                                onChange={(e) => {
                                                    const value = e.target.value
                                                        ? new Date(e.target.value).toISOString()
                                                        : null;
                                                    onSinceChange(connector.connector_id, value, defaultSince);
                                                }}
                                                disabled={disabled}
                                                className="h-7 max-w-[180px] flex-1 text-xs"
                                            />
                                            {/* Reset to default button */}
                                            <Button
                                                aria-label="Reset to default"
                                                size="sm"
                                                variant="ghost"
                                                className="h-6 w-6 p-0"
                                                onClick={() => onSinceReset(connector.connector_id)}
                                                title={`Reset to default: ${formatDateTime(defaultSince)}`}
                                                disabled={disabled || !hasSinceOverride}
                                            >
                                                <LuRotateCcw size={12} />
                                            </Button>
                                            {/* Clear for full sync button */}
                                            <Button
                                                aria-label="Clear for full sync"
                                                size="sm"
                                                variant="ghost"
                                                colorScheme={isFullSync ? 'red' : 'gray'}
                                                className="h-6 w-6 p-0"
                                                onClick={() => onSinceClear(connector.connector_id)}
                                                title="Clear for full sync"
                                                disabled={disabled}
                                            >
                                                <LuX size={12} />
                                            </Button>
                                            {/* Status badges */}
                                            {hasSinceOverride && !isFullSync && (
                                                <Badge colorScheme="blue">modified</Badge>
                                            )}
                                            {isFullSync && (
                                                <Badge colorScheme="orange">⚠️ full sync</Badge>
                                            )}
                                            {!hasSinceOverride && !isFullSync && (
                                                <Badge colorScheme="gray">auto</Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Effective fetch window (hidden while a since override is set) */}
                                    {isEnabled && !isTestMode && !hasSinceOverride && connector.sync_window && (
                                        <div className="mt-1 pl-6 text-[10px] text-slate-500">
                                            Fetch: {describeSyncWindow(connector.sync_window)}
                                        </div>
                                    )}

                                    {/* Special Note for Binance Deposits/Withdrawals */}
                                    {isEnabled && !isTestMode && (connector.connector_type === 'binance-deposits' || connector.connector_type === 'binance-withdrawals') && (
                                        <div className="mt-1 flex items-start gap-2 pl-6">
                                            <span className="text-[10px] italic text-orange-600">
                                                Note: Default start date is 90 days ago. If start date is set, end date is start date + 90 days.
                                            </span>
                                        </div>
                                    )}

                                    {/* Special Note for MEXC API Connectors (Transactions, Deposits, Withdrawals) */}
                                    {isEnabled && !isTestMode && !connector.is_file_connector && (connector.connector_type === 'mexc-transactions' || connector.connector_type === 'mexc-deposits' || connector.connector_type === 'mexc-withdrawals') && (
                                        <div className="mt-1 flex items-start gap-2 pl-6">
                                            <span className="text-[10px] italic text-orange-600">
                                                ⚠️ Note: MEXC API cannot retrieve data older than 90 days.
                                            </span>
                                        </div>
                                    )}

                                    {/* Row 3: Symbols filter (for trade connectors) */}
                                    {supportsSymbols && isEnabled && !isTestMode && (
                                        <div className="mt-2 flex items-center gap-2 pl-6">
                                            <span className="min-w-[50px] text-xs text-slate-500">Symbols:</span>
                                            <CommaSeparatedInput
                                                value={currentSymbols}
                                                onChange={(symbols) => onSymbolsChange(connector.connector_id, symbols)}
                                                placeholder="All symbols (e.g., BTC/USDT, ETH/USDT)"
                                                disabled={disabled}
                                            />
                                            {hasSymbolsOverride && (
                                                <Button
                                                    aria-label="Clear symbols filter"
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 w-6 p-0"
                                                    onClick={() => onSymbolsChange(connector.connector_id, null)}
                                                    title="Clear filter (use all symbols)"
                                                    disabled={disabled}
                                                >
                                                    <LuX size={12} />
                                                </Button>
                                            )}
                                            {hasSymbolsOverride && (
                                                <Badge colorScheme="blue">filtered</Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Row 4: Currencies filter (for deposit/withdrawal connectors) */}
                                    {supportsCurrencies && isEnabled && !isTestMode && (
                                        <div className="mt-2 flex items-center gap-2 pl-6">
                                            <span className="min-w-[50px] text-xs text-slate-500">Currencies:</span>
                                            <CommaSeparatedInput
                                                value={currentCurrencies}
                                                onChange={(currencies) => onCurrenciesChange(connector.connector_id, currencies)}
                                                placeholder="All currencies (e.g., BTC, ETH, USDT)"
                                                disabled={disabled}
                                                uppercase
                                            />
                                            {hasCurrenciesOverride && (
                                                <Button
                                                    aria-label="Clear currencies filter"
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 w-6 p-0"
                                                    onClick={() => onCurrenciesChange(connector.connector_id, null)}
                                                    title="Clear filter (use all currencies)"
                                                    disabled={disabled}
                                                >
                                                    <LuX size={12} />
                                                </Button>
                                            )}
                                            {hasCurrenciesOverride && (
                                                <Badge colorScheme="blue">filtered</Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Row 5: File Upload (for file connectors) */}
                                    {connector.is_file_connector && isEnabled && !isTestMode && (
                                        <ConnectorFileUpload
                                            connectorId={connector.connector_id}
                                            connectorType={connector.connector_type}
                                            disabled={disabled}
                                            onUploadComplete={() => onFileUploadComplete(connector.connector_id)}
                                            defaultFileName={connector.config?.default_file_name}
                                        />
                                    )}

                                    {/* Row 6: Job snippet - only show if enabled */}
                                    {isEnabled && (
                                        <div className="mt-2">
                                            <ConnectorJobSnippet
                                                connector={connector}
                                                onClick={() => onJobSnippetClick(connector)}
                                            />
                                        </div>
                                    )}

                                    {/* Row 7: Last synced transaction - compact inline */}
                                    {isEnabled && connector.last_synced_transaction && (
                                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                                            <span className="text-slate-500">Last:</span>
                                            <Badge colorScheme="green">
                                                {new Date(connector.last_synced_transaction.datetime).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                {' '}
                                                {new Date(connector.last_synced_transaction.datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </Badge>
                                            <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
                                                {connector.last_synced_transaction.type.toUpperCase()}
                                                {' '}
                                                {connector.last_synced_transaction.qty?.toFixed(4) || ''}
                                                {' '}
                                                {connector.last_synced_transaction.asset}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    };

export const SyncConfigPanel: React.FC<SyncConfigPanelProps> = ({
    onOverridesChange,
    onConfigDataChange,
    disabled = false,
}) => {
    // ── All connectors / accounts from backend (full catalog) ──────────
    const [allConnectors, setAllConnectors] = useState<EnabledConnector[]>([]);
    const [allAccounts, setAllAccounts] = useState<AccountSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);

    // ── Sync config store (persists selected connector IDs) ────────────
    const configStore = useSyncConfigStore();

    // ── Picker modal state ─────────────────────────────────────────────
    const [pickerOpen, setPickerOpen] = useState(false);

    // ── Derived: filter full catalog to only selected connectors ───────
    const connectors = useMemo(
        () => allConnectors.filter(c => configStore.selectedIds.has(c.connector_id)),
        [allConnectors, configStore.selectedIds],
    );
    const accounts = useMemo(() => {
        const selectedAccountIds = new Set(connectors.map(c => c.account_id));
        return allAccounts.filter(a => selectedAccountIds.has(a.id));
    }, [allAccounts, connectors]);

    // Track overrides as a map: connector_id -> override settings
    const [overrides, setOverrides] = useState<Map<number, ConnectorOverride>>(new Map());

    // Track account-level overrides (enabling/disabling all connectors for an account)
    const [accountOverrides, setAccountOverrides] = useState<Map<number, boolean>>(new Map());

    // Track collapsed state for disabled accounts (horizontal collapse)
    const [collapsedAccounts, setCollapsedAccounts] = useState<Map<number, boolean>>(new Map());

    // Job detail drawer state
    const [selectedJobConnector, setSelectedJobConnector] = useState<EnabledConnector | null>(null);
    const [jobDrawerOpen, setJobDrawerOpen] = useState(false);

    // Balance drawer state
    const [balanceDrawerOpen, setBalanceDrawerOpen] = useState(false);
    const [balanceMode, setBalanceMode] = useState<'global' | 'account'>('global');
    const [balanceAccountId, setBalanceAccountId] = useState<number | undefined>();
    const [balanceTitle, setBalanceTitle] = useState<string | undefined>();

    const handleBalanceClick = useCallback((accountId: number) => {
        const account = accounts.find(a => a.id === accountId);
        setBalanceMode('account');
        setBalanceAccountId(accountId);
        setBalanceTitle(account ? `${account.name} Balance` : 'Account Balance');
        setBalanceDrawerOpen(true);
    }, [accounts]);

    const handleGlobalBalanceClick = useCallback(() => {
        setBalanceMode('global');
        setBalanceAccountId(undefined);
        setBalanceTitle('Global Balance');
        setBalanceDrawerOpen(true);
    }, []);

    // Test fixture state: connector_id -> { filename, path, itemCount }
    const [testFixtures, setTestFixtures] = useState<Map<number, { filename: string; path: string; itemCount: number }>>(new Map());
    const [fixtureUploading, setFixtureUploading] = useState<number | null>(null);
    // JSON preview dialog state
    const [previewConnectorId, setPreviewConnectorId] = useState<number | null>(null);
    const [previewData, setPreviewData] = useState<any[] | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    // Load existing fixture status when test_mode is active on a connector
    useEffect(() => {
        const loadFixtureStatuses = async () => {
            const connectorsWithTestMode = connectors.filter(c => {
                const override = overrides.get(c.connector_id);
                return (override?.test_mode ?? c.test_mode) && !testFixtures.has(c.connector_id);
            });
            for (const c of connectorsWithTestMode) {
                try {
                    const resp = await fetch(`${API_URL}/fixtures/connectors/${c.connector_id}/test-fixture`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.has_fixture) {
                            setTestFixtures(prev => {
                                const next = new Map(prev);
                                next.set(c.connector_id, {
                                    filename: `${c.connector_id}.json`,
                                    path: data.test_file_path || `data/input/fixtures/${c.connector_id}.json`,
                                    itemCount: data.item_count ?? 0,
                                });
                                return next;
                            });
                        }
                    }
                } catch { /* ignore */ }
            }
        };
        loadFixtureStatuses();
    }, [connectors, overrides]);

    const handleTestFileUpload = useCallback(async (connectorId: number, file: File) => {
        setFixtureUploading(connectorId);
        try {
            const fd = new FormData();
            fd.append('file', file);
            const resp = await fetch(`${API_URL}/fixtures/connectors/${connectorId}/test-fixture`, {
                method: 'POST',
                body: fd,
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.detail || 'Upload failed');
            }
            const result = await resp.json();
            setTestFixtures(prev => {
                const next = new Map(prev);
                next.set(connectorId, {
                    filename: file.name,
                    path: result.path,
                    itemCount: result.item_count,
                });
                return next;
            });
            // Add test_file_path to override
            setOverrides(prev => {
                const next = new Map(prev);
                const existing = next.get(connectorId) || { connector_id: connectorId };
                next.set(connectorId, { ...existing, test_mode: true, test_file_path: result.path });
                return next;
            });
        } catch (err) {
            console.error('Failed to upload test fixture:', err);
        } finally {
            setFixtureUploading(null);
        }
    }, []);

    const handleTestFileRemove = useCallback(async (connectorId: number) => {
        setFixtureUploading(connectorId);
        try {
            await fetch(`${API_URL}/fixtures/connectors/${connectorId}/test-fixture`, { method: 'DELETE' });
            setTestFixtures(prev => {
                const next = new Map(prev);
                next.delete(connectorId);
                return next;
            });
            // Remove test_file_path from override
            setOverrides(prev => {
                const next = new Map(prev);
                const existing = next.get(connectorId);
                if (existing) {
                    const { test_file_path: _, ...rest } = existing;
                    next.set(connectorId, rest as ConnectorOverride);
                }
                return next;
            });
        } catch (err) {
            console.error('Failed to remove test fixture:', err);
        } finally {
            setFixtureUploading(null);
        }
    }, []);

    const handlePreviewFixture = useCallback(async (connectorId: number) => {
        setPreviewConnectorId(connectorId);
        setPreviewLoading(true);
        setPreviewData(null);
        try {
            // Fetch the fixture file content via a dedicated endpoint
            const resp = await fetch(`${API_URL}/fixtures/connectors/${connectorId}/test-fixture/content`);
            if (resp.ok) {
                const data = await resp.json();
                setPreviewData(data);
            }
        } catch { /* ignore */ } finally {
            setPreviewLoading(false);
        }
    }, []);

    // Initialize collapsed state for disabled accounts (all disabled accounts collapsed by default)
    useEffect(() => {
        // Only initialize if collapsedAccounts is empty (first load)
        if (collapsedAccounts.size > 0) return;

        const initialCollapsed = new Map<number, boolean>();
        accounts.forEach(account => {
            const accountConnectors = connectors.filter(c => c.account_id === account.id);
            // Check if any connector is enabled at base level (before overrides)
            const enabledCount = accountConnectors.filter(c => c.enabled && (c.account_enabled ?? true)).length;
            if (enabledCount === 0) {
                initialCollapsed.set(account.id, true);
            }
        });
        setCollapsedAccounts(initialCollapsed);
    }, [accounts, connectors]);

    // Fetch all connectors
    const fetchConnectors = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch(`${API_URL}/sync-job/all-connectors`);
            if (!response.ok) throw new Error('Failed to fetch connectors');
            const data: AllConnectorsResponse = await response.json();
            setAllConnectors(data.connectors);
            setAllAccounts(data.accounts);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchConnectors();
    }, [fetchConnectors]);

    // Report selected connectors/accounts to parent whenever they change
    useEffect(() => {
        onConfigDataChange?.(connectors, accounts);
    }, [connectors, accounts, onConfigDataChange]);

    // Group connectors by account
    const connectorsByAccount = useMemo(() => {
        const grouped = new Map<number, EnabledConnector[]>();
        for (const connector of connectors) {
            const list = grouped.get(connector.account_id) || [];
            list.push(connector);
            grouped.set(connector.account_id, list);
        }
        return grouped;
    }, [connectors]);

    // Group accounts by type (flat — no group nesting)
    const accountsByType = useMemo(() => {
        const result = new Map<string, AccountSummary[]>();
        for (const type of ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment']) {
            const typeAccounts = accounts.filter(a => a.account_type === type);
            if (typeAccounts.length > 0) {
                result.set(type, typeAccounts);
            }
        }
        return result;
    }, [accounts]);

    // Track collapsed state for account type sections
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

    // Calculate effective enabled state for each connector
    const getEffectiveEnabled = useCallback((connector: EnabledConnector) => {
        const override = overrides.get(connector.connector_id);
        if (override?.enabled !== undefined) return override.enabled;

        // Check account-level override
        const accountOverride = accountOverrides.get(connector.account_id);
        if (accountOverride !== undefined) return accountOverride;

        // Default to connector's base enabled state AND account's enabled state
        return connector.enabled && (connector.account_enabled ?? true);
    }, [overrides, accountOverrides]);

    // Update parent when overrides change
    useEffect(() => {
        const overrideList: ConnectorOverride[] = [];

        // 1. Add explicit connector overrides for SELECTED connectors
        for (const [connectorId, override] of overrides) {
            // Only include overrides for connectors in the selection
            if (!configStore.selectedIds.has(connectorId)) continue;
            if (override.enabled !== undefined || override.test_mode !== undefined ||
                override.since_datetime !== undefined || override.symbols !== undefined ||
                override.currencies !== undefined || override.test_file_path !== undefined) {
                overrideList.push(override);
            }
        }

        // 2. Add account-level overrides as individual connector overrides
        for (const [accountId, enabled] of accountOverrides) {
            const accountConnectors = connectorsByAccount.get(accountId) || [];
            for (const connector of accountConnectors) {
                // Only add if not already explicitly overridden
                if (!overrides.has(connector.connector_id)) {
                    overrideList.push({
                        connector_id: connector.connector_id,
                        enabled,
                    });
                }
            }
        }

        // 3. For connectors NOT in the selection, send enabled: false so the
        //    backend skips them (backend defaults to DB enabled state otherwise)
        const selectedAndOverriddenIds = new Set(overrideList.map(o => o.connector_id));
        for (const c of allConnectors) {
            if (!configStore.selectedIds.has(c.connector_id) && !selectedAndOverriddenIds.has(c.connector_id)) {
                overrideList.push({ connector_id: c.connector_id, enabled: false });
            }
        }

        onOverridesChange(overrideList);
    }, [overrides, accountOverrides, connectorsByAccount, onOverridesChange, configStore.selectedIds, allConnectors]);

    const handleConnectorEnabledChange = (connectorId: number, enabled: boolean, defaultEnabled: boolean) => {
        // Check if this change makes all connectors in the account disabled
        const connector = connectors.find(c => c.connector_id === connectorId);
        const accountId = connector?.account_id;
        const accountConnectors = accountId ? (connectorsByAccount.get(accountId) || []) : [];

        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (enabled === defaultEnabled) {
                const { enabled: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, enabled });
            }

            // Compute if all connectors will be disabled after this change
            if (accountId) {
                const allDisabled = accountConnectors.every(c => {
                    if (c.connector_id === connectorId) {
                        // For the connector being changed, use the new enabled value
                        return !enabled;
                    } else {
                        // For other connectors, check their effective enabled state with the new overrides
                        const override = next.get(c.connector_id);
                        const accountOverride = accountOverrides.get(c.account_id);

                        if (override?.enabled !== undefined) {
                            return !override.enabled;
                        }
                        if (accountOverride !== undefined) {
                            return !accountOverride;
                        }
                        return !(c.enabled && (c.account_enabled ?? true));
                    }
                });

                // Update collapsed state based on whether all are disabled
                setCollapsedAccounts(prevCollapsed => {
                    const nextCollapsed = new Map(prevCollapsed);
                    if (allDisabled) {
                        nextCollapsed.set(accountId, true);
                    } else if (nextCollapsed.get(accountId)) {
                        // Only auto-expand if it was collapsed
                        nextCollapsed.set(accountId, false);
                    }
                    return nextCollapsed;
                });
            }

            return next;
        });
    };

    const handleTestModeChange = (connectorId: number, testMode: boolean, defaultTestMode: boolean) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (testMode === defaultTestMode) {
                const { test_mode: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, test_mode: testMode });
            }
            return next;
        });
    };

    const handleSinceChange = (connectorId: number, since: string | null, defaultSince: string | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            // If value matches default, remove the override
            if (since === defaultSince) {
                const { since_datetime: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, since_datetime: since });
            }
            return next;
        });
    };

    const handleSinceReset = (connectorId: number) => {
        // Remove the since_datetime override to use default
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId);
            if (existing) {
                const { since_datetime: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            }
            return next;
        });
    };

    const handleSinceClear = (connectorId: number) => {
        // Explicitly set since_datetime to null for full sync
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };
            next.set(connectorId, { ...existing, since_datetime: null });
            return next;
        });
    };

    const handleSymbolsChange = (connectorId: number, symbols: string[] | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (symbols === null) {
                // Remove the symbols override
                const { symbols: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, symbols });
            }
            return next;
        });
    };

    const handleCurrenciesChange = (connectorId: number, currencies: string[] | null) => {
        setOverrides((prev) => {
            const next = new Map(prev);
            const existing = next.get(connectorId) || { connector_id: connectorId };

            if (currencies === null) {
                // Remove the currencies override
                const { currencies: _, ...rest } = existing;
                if (Object.keys(rest).length === 1) {
                    next.delete(connectorId);
                } else {
                    next.set(connectorId, rest as ConnectorOverride);
                }
            } else {
                next.set(connectorId, { ...existing, currencies });
            }
            return next;
        });
    };

    // Handle file upload completion - refresh connector data
    const handleFileUploadComplete = useCallback((connectorId: number) => {
        // Refresh connectors to get updated import history
        fetchConnectors();
    }, [fetchConnectors]);

    // Handle job snippet click - open drawer for specific connector's job
    const handleJobSnippetClick = (connector: EnabledConnector) => {
        setSelectedJobConnector(connector);
        setJobDrawerOpen(true);
    };

    // Toggle horizontal collapse for disabled account
    const toggleAccountCollapse = (accountId: number) => {
        setCollapsedAccounts(prev => {
            const next = new Map(prev);
            next.set(accountId, !prev.get(accountId));
            return next;
        });
    };

    const handleAccountToggle = (accountId: number, enabled: boolean) => {
        const accountConnectors = connectorsByAccount.get(accountId) || [];

        // Set individual connector overrides for each connector in this account
        // This ensures ALL connectors are set to the desired state regardless of their defaults
        setOverrides(prev => {
            const next = new Map(prev);
            for (const c of accountConnectors) {
                const defaultEnabled = c.enabled && (c.account_enabled ?? true);
                const existing = next.get(c.connector_id) || { connector_id: c.connector_id };

                if (enabled === defaultEnabled) {
                    // Matches default — remove the enabled override but keep other overrides (test_mode, since, etc.)
                    const { enabled: _, ...rest } = existing;
                    if (Object.keys(rest).length <= 1) {
                        next.delete(c.connector_id);
                    } else {
                        next.set(c.connector_id, rest as ConnectorOverride);
                    }
                } else {
                    next.set(c.connector_id, { ...existing, enabled });
                }
            }
            return next;
        });

        // Clear any account-level override since we're using per-connector overrides
        setAccountOverrides(prev => {
            const next = new Map(prev);
            next.delete(accountId);
            return next;
        });

        // Automatically collapse/expand account based on enabled state
        setCollapsedAccounts(prev => {
            const next = new Map(prev);
            if (!enabled) {
                next.set(accountId, true);
            } else {
                next.set(accountId, false);
            }
            return next;
        });
    };

    const selectAll = () => {
        setOverrides(new Map());
        setAccountOverrides(new Map());
        // Set all accounts to enabled if they weren't by default
        const newAccountOverrides = new Map<number, boolean>();
        for (const account of accounts) {
            if (!account.enabled) {
                newAccountOverrides.set(account.id, true);
            }
        }
        // Set all connectors to enabled if they weren't by default
        const newOverrides = new Map<number, ConnectorOverride>();
        for (const connector of connectors) {
            if (!connector.enabled) {
                newOverrides.set(connector.connector_id, {
                    connector_id: connector.connector_id,
                    enabled: true,
                });
            }
        }
        setAccountOverrides(newAccountOverrides);
        setOverrides(newOverrides);
    };

    const selectNone = () => {
        setOverrides(new Map());
        const newAccountOverrides = new Map<number, boolean>();
        for (const account of accounts) {
            newAccountOverrides.set(account.id, false);
        }
        setAccountOverrides(newAccountOverrides);
    };

    const resetOverrides = () => {
        setOverrides(new Map());
        setAccountOverrides(new Map());
    };

    const refreshConfiguration = () => {
        // Refresh connectors and accounts from backend
        fetchConnectors();
        // Clear overrides
        resetOverrides();
    };

    // ── Remove an account from the sync config ────────────────────────
    const handleRemoveAccount = useCallback((accountId: number) => {
        const accountConnectorIds = (connectorsByAccount.get(accountId) || []).map(c => c.connector_id);
        configStore.removeConnectors(accountConnectorIds);
        // Clean up any overrides for removed connectors
        setOverrides(prev => {
            const next = new Map(prev);
            for (const id of accountConnectorIds) next.delete(id);
            return next;
        });
        setAccountOverrides(prev => {
            const next = new Map(prev);
            next.delete(accountId);
            return next;
        });
    }, [connectorsByAccount, configStore]);

    // ── Handle picker modal confirmation ──────────────────────────────
    const handlePickerConfirm = useCallback((selectedIds: Set<number>) => {
        configStore.replaceAll(Array.from(selectedIds));
        // Clean up overrides for connectors no longer in selection
        setOverrides(prev => {
            const next = new Map(prev);
            for (const id of prev.keys()) {
                if (!selectedIds.has(id)) next.delete(id);
            }
            return next;
        });
        setAccountOverrides(prev => {
            // Remove account overrides whose accounts are no longer represented
            const selectedAccountIds = new Set(
                allConnectors.filter(c => selectedIds.has(c.connector_id)).map(c => c.account_id)
            );
            const next = new Map(prev);
            for (const accountId of prev.keys()) {
                if (!selectedAccountIds.has(accountId)) next.delete(accountId);
            }
            return next;
        });
        setPickerOpen(false);
        // Auto-expand to show results
        if (selectedIds.size > 0 && !expanded) {
            setExpanded(true);
        }
    }, [configStore, allConnectors, expanded]);

    const hasOverrides = overrides.size > 0 || accountOverrides.size > 0;
    const enabledCount = connectors.filter(c => getEffectiveEnabled(c)).length;

    if (loading) {
        return (
            <div className="p-4 text-center">
                <Spinner size="sm" />
                <p className="mt-2 text-sm text-slate-500">
                    Loading connectors...
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-600">
                    Failed to load connectors: {error}
                </p>
                <Button size="sm" className="mt-2" onClick={fetchConnectors} colorScheme="gray" variant="outline">
                    Retry
                </Button>
            </div>
        );
    }

    if (allConnectors.length === 0) {
        return (
            <div className="border border-yellow-200 bg-yellow-50 p-3">
                <p className="text-sm text-yellow-700">
                    No connectors found. Configure connectors in Settings → Accounts.
                </p>
            </div>
        );
    }

    return (
        <div className={`overflow-hidden border bg-white ${hasOverrides ? 'border-orange-300' : 'border-slate-200'}`}>
            {/* Header */}
            <div
                onClick={() => setExpanded(!expanded)}
                className={`cursor-pointer p-3 transition-colors ${hasOverrides ? 'bg-orange-50 hover:bg-orange-100' : 'bg-slate-50 hover:bg-slate-100'}`}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700">⚙️ Sync Configuration</span>
                        <Badge colorScheme="blue">
                            {enabledCount}/{connectors.length} enabled
                        </Badge>
                        {hasOverrides && (
                            <Badge colorScheme="orange">
                                modified
                            </Badge>
                        )}
                    </div>
                    <span className="text-sm text-slate-400">{expanded ? '▼' : '▶'}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                    Configure which connectors to include and their test mode settings
                </p>
            </div>

            {/* Expanded content */}
            {expanded && (
                <div className="border-t border-slate-100 bg-white p-3">
                    {/* Action buttons */}
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1">
                            <Button
                                size="xs"
                                colorScheme="blue"
                                variant="outline"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setPickerOpen(true);
                                }}
                                disabled={disabled}
                            >
                                <LuPlus size={12} />
                                Add
                            </Button>
                            {configStore.hasSelection && (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    colorScheme="gray"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        configStore.clearAll();
                                        resetOverrides();
                                    }}
                                    disabled={disabled}
                                >
                                    Clear All
                                </Button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {connectors.length > 0 && (
                                <>
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            selectAll();
                                        }}
                                        disabled={disabled}
                                    >
                                        All
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            selectNone();
                                        }}
                                        disabled={disabled}
                                    >
                                        None
                                    </Button>
                                </>
                            )}
                            {hasOverrides && (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    colorScheme="gray"
                                    className="border-orange-300 text-orange-700 hover:bg-orange-50"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        resetOverrides();
                                    }}
                                    disabled={disabled}
                                >
                                    Reset
                                </Button>
                            )}
                            <Button
                                size="xs"
                                variant="ghost"
                                colorScheme="blue"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    refreshConfiguration();
                                }}
                                disabled={disabled || loading}
                            >
                                🔄 Refresh
                            </Button>
                            <Button
                                size="xs"
                                variant="ghost"
                                colorScheme="green"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGlobalBalanceClick();
                                }}
                            >
                                <FiPieChart size={12} />
                                Balance
                            </Button>
                        </div>
                    </div>

                    {/* Empty state */}
                    {connectors.length === 0 && (
                        <div className="border border-dashed border-slate-200 bg-slate-50 py-8 text-center">
                            <p className="mb-3 text-sm text-slate-500">
                                No accounts configured for sync.
                            </p>
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={() => setPickerOpen(true)}
                                disabled={disabled}
                            >
                                <LuPlus size={14} />
                                Add Accounts & Connectors
                            </Button>
                        </div>
                    )}

                    {/* Account Type Sections */}
                    {[{ type: 'cex', label: '🏦 CEX', colorScheme: 'blue' },
                    { type: 'dex', label: '🔗 DEX', colorScheme: 'cyan' },
                    { type: 'wallet', label: '💼 Wallets', colorScheme: 'purple' },
                    { type: 'broker', label: '📊 Brokers', colorScheme: 'green' },
                    { type: 'bank', label: '🏛️ Banks', colorScheme: 'teal' },
                    { type: 'investment', label: '📈 Investments', colorScheme: 'orange' }]
                        .filter(section => accountsByType.has(section.type))
                        .map(section => {
                            const allTypeAccounts = accountsByType.get(section.type)!;
                            const sectionConnectors = allTypeAccounts.flatMap(a => connectorsByAccount.get(a.id) || []);
                            const sectionEnabledCount = sectionConnectors.filter(c => getEffectiveEnabled(c)).length;
                            const isCollapsed = collapsedSections[section.type] ?? false;
                            const allEnabled = sectionConnectors.length > 0 && sectionConnectors.every(c => getEffectiveEnabled(c));
                            const isMixed = sectionEnabledCount > 0 && !allEnabled;

                            const toggleSectionAll = (enabled: boolean) => {
                                allTypeAccounts.forEach(account => {
                                    handleAccountToggle(account.id, enabled);
                                });
                            };

                            return (
                                <div key={section.type} className="mb-4">
                                    {/* Type Section Header */}
                                    <div
                                        onClick={() => setCollapsedSections(prev => ({ ...prev, [section.type]: !isCollapsed }))}
                                        className={`mb-2 flex cursor-pointer items-center justify-between px-2 py-2 ${SECTION_COLORS[section.colorScheme].bg} ${SECTION_COLORS[section.colorScheme].hoverBg}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-slate-400">{isCollapsed ? '▶' : '▼'}</span>
                                            <span className="text-sm font-medium text-slate-700">
                                                {section.label}
                                            </span>
                                            <Badge colorScheme="gray">
                                                {allTypeAccounts.length} {allTypeAccounts.length === 1 ? 'account' : 'accounts'}
                                            </Badge>
                                            <Badge colorScheme="blue">
                                                {sectionEnabledCount}/{sectionConnectors.length}
                                            </Badge>
                                        </div>
                                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                            <Tooltip
                                                content={(() => {
                                                    if (allEnabled) return `Click to disable all ${section.label} connectors`;
                                                    if (sectionEnabledCount > 0) return `${sectionEnabledCount} of ${sectionConnectors.length} enabled - Click to enable all`;
                                                    return `Click to enable all ${section.label} connectors`;
                                                })()}
                                                openDelay={300}
                                            >
                                                <span className="inline-flex">
                                                    <input
                                                        type="checkbox"
                                                        title={`Toggle all ${section.label} connectors`}
                                                        checked={allEnabled}
                                                        ref={(el) => { if (el) el.indeterminate = isMixed; }}
                                                        disabled={disabled}
                                                        onChange={(e) => {
                                                            toggleSectionAll(isMixed ? true : e.target.checked);
                                                        }}
                                                        className="h-4 w-4 cursor-pointer accent-blue-500"
                                                    />
                                                </span>
                                            </Tooltip>
                                        </div>
                                    </div>

                                    {/* Account Cards Grid */}
                                    {!isCollapsed && (
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
                                            {allTypeAccounts.map((account) => {
                                                const accountConnectors = connectorsByAccount.get(account.id) || [];
                                                if (accountConnectors.length === 0) return null;

                                                return (
                                                    <AccountCard
                                                        key={account.id}
                                                        account={account}
                                                        connectors={accountConnectors}
                                                        overrides={overrides}
                                                        accountOverride={accountOverrides.get(account.id)}
                                                        getEffectiveEnabled={getEffectiveEnabled}
                                                        onAccountToggle={(enabled) => handleAccountToggle(account.id, enabled)}
                                                        onConnectorEnabledChange={handleConnectorEnabledChange}
                                                        onTestModeChange={handleTestModeChange}
                                                        onTestFileUpload={handleTestFileUpload}
                                                        onTestFileRemove={handleTestFileRemove}
                                                        testFixtures={testFixtures}
                                                        fixtureUploading={fixtureUploading}
                                                        onPreviewFixture={handlePreviewFixture}
                                                        onSinceChange={handleSinceChange}
                                                        onSinceReset={handleSinceReset}
                                                        onSinceClear={handleSinceClear}
                                                        onSymbolsChange={handleSymbolsChange}
                                                        onCurrenciesChange={handleCurrenciesChange}
                                                        onFileUploadComplete={handleFileUploadComplete}
                                                        onJobSnippetClick={handleJobSnippetClick}
                                                        onBalanceClick={handleBalanceClick}
                                                        onRemove={() => handleRemoveAccount(account.id)}
                                                        isCollapsed={collapsedAccounts.get(account.id) ?? false}
                                                        onToggleCollapse={() => toggleAccountCollapse(account.id)}
                                                        disabled={disabled}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                </div>
            )}

            {/* Job Detail Drawer */}
            {selectedJobConnector && (
                <JobDetailDrawer
                    jobId={null}  // Will show the latest job
                    open={jobDrawerOpen}
                    onClose={() => {
                        setJobDrawerOpen(false);
                        setSelectedJobConnector(null);
                    }}
                />
            )}

            {/* Balance Drawer */}
            <BalanceDrawer
                isOpen={balanceDrawerOpen}
                onClose={() => setBalanceDrawerOpen(false)}
                mode={balanceMode}
                accountId={balanceAccountId}
                title={balanceTitle}
            />

            {/* Connector Picker Modal */}
            <ConnectorPickerModal
                isOpen={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onConfirm={handlePickerConfirm}
                allConnectors={allConnectors}
                allAccounts={allAccounts}
                alreadySelected={configStore.selectedIds}
            />

            {/* Test Fixture Preview Dialog */}
            <RadixDialog.Root open={previewConnectorId !== null} onOpenChange={(open) => { if (!open) { setPreviewConnectorId(null); setPreviewData(null); } }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[80vh] w-full max-w-[600px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-4 py-3">
                            <RadixDialog.Title className="text-sm font-semibold">🧪 Test Fixture Preview</RadixDialog.Title>
                        </div>
                        <div className="max-h-[60vh] overflow-y-auto p-4">
                            {previewLoading ? (
                                <div className="flex justify-center py-4"><Spinner size="sm" /></div>
                            ) : previewData ? (
                                <div>
                                    <p className="mb-2 text-xs text-slate-500">{previewData.length} items</p>
                                    <pre className="max-h-[60vh] overflow-x-auto whitespace-pre-wrap break-all bg-slate-50 p-3 text-xs">
                                        {JSON.stringify(previewData, null, 2)}
                                    </pre>
                                </div>
                            ) : (
                                <p className="text-sm text-slate-500">No data available</p>
                            )}
                        </div>
                        <div className="flex justify-end border-t border-slate-200 px-4 py-3">
                            <Button size="sm" variant="outline" onClick={() => { setPreviewConnectorId(null); setPreviewData(null); }}>
                                Close
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>
        </div>
    );
};
