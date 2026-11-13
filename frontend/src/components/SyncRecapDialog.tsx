import React, { useMemo } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import {
    ConnectorOverride,
    EnabledConnector,
    AccountSummary,
} from '../types';
import { Badge, Button } from './ui/primitives';

interface SyncRecapDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    connectors: EnabledConnector[];
    accounts: AccountSummary[];
    overrides: ConnectorOverride[];
    renormalize?: boolean;
    loading?: boolean;
}

const formatDateTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return isoString;
    }
};

export const SyncRecapDialog: React.FC<SyncRecapDialogProps> = ({
    isOpen,
    onClose,
    onConfirm,
    connectors,
    accounts,
    overrides,
    renormalize = false,
    loading = false,
}) => {
    const overridesMap = useMemo(() => {
        const map = new Map<number, ConnectorOverride>();
        for (const o of overrides) map.set(o.connector_id, o);
        return map;
    }, [overrides]);

    // Compute effective enabled state for each connector
    const getEffectiveEnabled = (c: EnabledConnector): boolean => {
        const override = overridesMap.get(c.connector_id);
        if (override?.enabled !== undefined) return override.enabled;
        return c.enabled && (c.account_enabled ?? true);
    };

    const enabledConnectors = connectors.filter(c => getEffectiveEnabled(c));
    const disabledConnectors = connectors.filter(c => !getEffectiveEnabled(c));
    const enabledAccountIds = new Set(enabledConnectors.map(c => c.account_id));
    const enabledAccounts = accounts.filter(a => enabledAccountIds.has(a.id));
    const overriddenConnectors = enabledConnectors.filter(c => overridesMap.has(c.connector_id));
    const testModeConnectors = enabledConnectors.filter(c => {
        const o = overridesMap.get(c.connector_id);
        return o?.test_mode ?? c.test_mode;
    });
    const fileConnectors = enabledConnectors.filter(c => c.is_file_connector);

    // Group enabled connectors by account type → account name
    const grouped = useMemo(() => {
        const typeLabels: Record<string, string> = {
            cex: '🏦 Exchanges', dex: '🔗 DEX', wallet: '💼 Wallets',
            broker: '📊 Brokers', bank: '🏛️ Banks', investment: '📈 Investments',
        };
        const typeOrder = ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment', 'other'];
        const map = new Map<string, Map<string, EnabledConnector[]>>();

        for (const c of enabledConnectors) {
            const t = c.account_type || 'other';
            const a = c.account_name;
            if (!map.has(t)) map.set(t, new Map());
            const acctMap = map.get(t)!;
            if (!acctMap.has(a)) acctMap.set(a, []);
            acctMap.get(a)!.push(c);
        }

        const sorted = Array.from(map.entries()).sort(
            ([a], [b]) => (typeOrder.indexOf(a) === -1 ? 99 : typeOrder.indexOf(a)) - (typeOrder.indexOf(b) === -1 ? 99 : typeOrder.indexOf(b))
        );

        return { sorted, typeLabels };
    }, [enabledConnectors]);

    // Flatten all connectors into per-account cards
    const accountCards = useMemo(() => {
        const cards: { accountName: string; accountType: string; connectors: EnabledConnector[] }[] = [];
        for (const [, acctMap] of grouped.sorted) {
            for (const [acctName, cps] of acctMap.entries()) {
                const acctType = cps[0]?.account_type || '';
                cards.push({ accountName: acctName, accountType: acctType, connectors: cps });
            }
        }
        return cards;
    }, [grouped]);

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[900px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 p-4">
                        <div className="flex w-full items-center justify-between">
                            <RadixDialog.Title className="text-base font-semibold">
                                {renormalize ? '🔄 Re-Normalize Confirmation' : '🚀 Sync Job Summary'}
                            </RadixDialog.Title>
                            <div className="flex items-center gap-3">
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-slate-500">Connectors</span>
                                    <span className="text-sm font-bold">{enabledConnectors.length}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-slate-500">Accounts</span>
                                    <span className="text-sm font-bold">{enabledAccounts.length}</span>
                                </div>
                                {disabledConnectors.length > 0 && (
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-slate-400">Skipped</span>
                                        <span className="text-sm font-bold text-slate-400">{disabledConnectors.length}</span>
                                    </div>
                                )}
                                {overriddenConnectors.length > 0 && (
                                    <Badge colorScheme="orange">{overriddenConnectors.length} override{overriddenConnectors.length !== 1 ? 's' : ''}</Badge>
                                )}
                                {testModeConnectors.length > 0 && (
                                    <Badge colorScheme="orange">🧪 {testModeConnectors.length} test</Badge>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="p-4 pt-2">
                        {/* Warning for renormalize */}
                        {renormalize && (
                            <div className="mb-3 border border-orange-200 bg-orange-50 p-2">
                                <span className="text-xs font-medium text-orange-700">
                                    ⚠️ Re-normalization will delete existing normalized transactions and recreate them from stored raw data.
                                    Derived data (cost lots, P&L) will also be removed.
                                </span>
                            </div>
                        )}

                        {/* Warnings */}
                        {fileConnectors.length > 0 && (
                            <div className="mb-3 border border-blue-200 bg-blue-50 p-2">
                                <span className="text-xs text-blue-700">
                                    📁 {fileConnectors.length} file connector{fileConnectors.length > 1 ? 's' : ''} included — ensure files are uploaded before syncing.
                                </span>
                            </div>
                        )}

                        {/* Account cards in 3-column grid */}
                        <div className="max-h-[450px] overflow-y-auto">
                            <div className="grid grid-cols-3 gap-2">
                                {accountCards.map(({ accountName, accountType, connectors: cps }) => (
                                    <div key={accountName} className="border border-slate-200 bg-white">
                                        <div className="border-b border-slate-100 px-3 py-1.5">
                                            <div className="flex items-center gap-1.5">
                                                <span className="truncate text-xs font-semibold text-slate-700">
                                                    {accountName}
                                                </span>
                                                <Badge colorScheme="gray">{accountType}</Badge>
                                            </div>
                                        </div>
                                        <div className="px-3 py-1">
                                            {cps.map(c => {
                                                const o = overridesMap.get(c.connector_id);
                                                const hasOverride = !!o;
                                                const isTest = o?.test_mode ?? c.test_mode;
                                                const since = o?.since_datetime !== undefined ? o.since_datetime : (c.default_since_datetime ?? c.start_datetime ?? null);
                                                const symbols = o?.symbols;
                                                const currencies = o?.currencies;

                                                // Collect which fields were overridden
                                                const overriddenFields: string[] = [];
                                                if (o?.enabled !== undefined) overriddenFields.push('enabled');
                                                if (o?.test_mode !== undefined) overriddenFields.push('test mode');
                                                if (o?.since_datetime !== undefined) overriddenFields.push('since date');
                                                if (o?.symbols && o.symbols.length > 0) overriddenFields.push('symbols');
                                                if (o?.currencies && o.currencies.length > 0) overriddenFields.push('currencies');

                                                return (
                                                    <div
                                                        key={c.connector_id}
                                                        className="py-0.5"
                                                        style={hasOverride ? { paddingLeft: 6, borderLeft: '2px solid #fb923c' } : undefined}
                                                    >
                                                        <div className="flex flex-wrap items-center gap-1">
                                                            <span className="truncate text-xs text-slate-700">
                                                                {c.display_name || c.connector_type}
                                                            </span>
                                                            {c.is_file_connector && (
                                                                <Badge colorScheme="blue">📁</Badge>
                                                            )}
                                                            {isTest && (
                                                                <Badge colorScheme="orange">🧪</Badge>
                                                            )}
                                                            {c.chain_name && (
                                                                <Badge colorScheme="purple">{c.chain_name}</Badge>
                                                            )}
                                                        </div>
                                                        {overriddenFields.length > 0 && (
                                                            <span className="block truncate text-[10px] text-orange-500">
                                                                ⚙ {overriddenFields.join(', ')}
                                                            </span>
                                                        )}
                                                        {since && (
                                                            <span className="block text-[10px] text-slate-400">since {formatDateTime(since)}</span>
                                                        )}
                                                        {!since && c.supports_incremental_sync && (
                                                            <span className="block text-[10px] text-orange-500">⚠ full sync</span>
                                                        )}
                                                        {symbols && symbols.length > 0 && (
                                                            <span className="block truncate text-[10px] text-blue-500">{symbols.join(', ')}</span>
                                                        )}
                                                        {currencies && currencies.length > 0 && (
                                                            <span className="block truncate text-[10px] text-blue-500">{currencies.join(', ')}</span>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                        <Button variant="outline" onClick={onClose} disabled={loading}>
                            Cancel
                        </Button>
                        <Button
                            onClick={onConfirm}
                            loading={loading}
                            className={renormalize ? 'bg-purple-600 hover:bg-purple-700' : undefined}
                        >
                            {renormalize ? '🔄 Re-Normalize' : '🚀 Start Sync'}
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
