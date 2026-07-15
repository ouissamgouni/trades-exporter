/**
 * ConnectorPickerModal
 *
 * A searchable hybrid-tree modal for selecting which accounts and connectors
 * to include in the current sync configuration.
 *
 * Structure:  Account Type → Account Group → Account → Connector
 * Each level has a tri-state checkbox.  A search bar filters the tree live.
 * Accounts and connectors are shown with colored dots from useEntityColors.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import {
    Badge,
    Button,
    Input,
    Text,
} from './ui/primitives';
import { LuSearch } from 'react-icons/lu';
import { EnabledConnector, AccountSummary } from '../types';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';
import { formatAddress, formatChainName } from '../utils/addressUtils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConnectorPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Called with the full set of connector IDs the user wants selected. */
    onConfirm: (selectedConnectorIds: Set<number>) => void;
    allConnectors: EnabledConnector[];
    allAccounts: AccountSummary[];
    /** IDs already in the sync config — pre-checked on open. */
    alreadySelected: Set<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_META: { type: string; label: string; emoji: string; colorScheme: string }[] = [
    { type: 'cex', label: 'Exchanges', emoji: '🏦', colorScheme: 'blue' },
    { type: 'dex', label: 'DEX', emoji: '🔗', colorScheme: 'cyan' },
    { type: 'wallet', label: 'Wallets', emoji: '💼', colorScheme: 'purple' },
    { type: 'broker', label: 'Brokers', emoji: '📊', colorScheme: 'green' },
    { type: 'bank', label: 'Banks', emoji: '🏛️', colorScheme: 'teal' },
    { type: 'investment', label: 'Investments', emoji: '📈', colorScheme: 'orange' },
];

const SECTION_BG: Record<string, string> = {
    blue: 'bg-blue-50',
    cyan: 'bg-cyan-50',
    purple: 'bg-purple-50',
    green: 'bg-green-50',
    teal: 'bg-teal-50',
    orange: 'bg-orange-50',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Colour dot rendered next to an entity name. */
const ColorDot: React.FC<{ color: string; size?: number }> = ({ color, size = 8 }) => (
    <span
        className="inline-block shrink-0 rounded-full"
        style={{ width: `${size}px`, height: `${size}px`, backgroundColor: color }}
    />
);

interface TriCheckboxProps {
    checked: boolean;
    indeterminate: boolean;
    onChange: () => void;
}

const TriCheckbox: React.FC<TriCheckboxProps> = ({ checked, indeterminate, onChange }) => {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate;
    }, [indeterminate]);
    return (
        <input
            ref={ref}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            className="h-4 w-4 cursor-pointer accent-blue-500"
        />
    );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ConnectorPickerModal: React.FC<ConnectorPickerModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    allConnectors,
    allAccounts,
    alreadySelected,
}) => {
    const { getAccountColor, getConnectorColor } = useEntityColors();

    // ── Internal selection state ────────────────────────────────────────
    const [selected, setSelected] = useState<Set<number>>(() => new Set(alreadySelected));
    const [search, setSearch] = useState('');

    // Reset internal state whenever the modal opens
    React.useEffect(() => {
        if (isOpen) {
            setSelected(new Set(alreadySelected));
            setSearch('');
        }
    }, [isOpen, alreadySelected]);

    // ── Derived data structures ────────────────────────────────────────

    // Connectors grouped by account ID
    const connectorsByAccount = useMemo(() => {
        const m = new Map<number, EnabledConnector[]>();
        for (const c of allConnectors) {
            const list = m.get(c.account_id) || [];
            list.push(c);
            m.set(c.account_id, list);
        }
        return m;
    }, [allConnectors]);

    // Normalised search term
    const searchLower = search.trim().toLowerCase();

    // Does a connector match the search?
    const connectorMatches = useCallback(
        (c: EnabledConnector): boolean => {
            if (!searchLower) return true;
            const haystack = [
                c.display_name,
                c.connector_type,
                c.chain_name,
                c.wallet_address,
                c.connector_family,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(searchLower);
        },
        [searchLower],
    );

    // Does an account (or any of its connectors) match the search?
    const accountMatches = useCallback(
        (account: AccountSummary): boolean => {
            if (!searchLower) return true;
            const acctHaystack = [
                account.name,
                account.account_type,
                account.group,
                account.address_or_identifier,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (acctHaystack.includes(searchLower)) return true;
            // Also match if any connector matches
            const cps = connectorsByAccount.get(account.id) || [];
            return cps.some(connectorMatches);
        },
        [searchLower, connectorsByAccount, connectorMatches],
    );

    // Helper: does the account name itself match (so all connectors should show)?
    const accountNameMatches = useCallback(
        (a: AccountSummary): boolean => {
            if (!searchLower) return true;
            return [a.name, a.account_type, a.group, a.address_or_identifier]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(searchLower);
        },
        [searchLower],
    );

    // Build flat sections: type → accounts (no group nesting)
    const sections = useMemo(() => {
        const result: {
            type: string;
            label: string;
            emoji: string;
            colorScheme: string;
            accounts: {
                account: AccountSummary;
                connectors: EnabledConnector[];
                visibleConnectors: EnabledConnector[];
            }[];
        }[] = [];

        for (const meta of TYPE_META) {
            const typeAccounts = allAccounts.filter(a => a.account_type === meta.type && accountMatches(a));
            if (typeAccounts.length === 0) continue;

            const mapped = typeAccounts.map(a => {
                const allCps = connectorsByAccount.get(a.id) || [];
                const visible = searchLower
                    ? allCps.filter(c => connectorMatches(c) || accountNameMatches(a))
                    : allCps;
                return { account: a, connectors: allCps, visibleConnectors: visible };
            });

            result.push({ ...meta, accounts: mapped });
        }
        return result;
    }, [allAccounts, connectorsByAccount, accountMatches, connectorMatches, accountNameMatches, searchLower]);

    // ── Selection helpers ──────────────────────────────────────────────

    const toggleConnector = (id: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAccount = (accountId: number) => {
        const cps = connectorsByAccount.get(accountId) || [];
        const ids = cps.map(c => c.connector_id);
        const allSelected = ids.every(id => selected.has(id));
        setSelected(prev => {
            const next = new Set(prev);
            if (allSelected) {
                ids.forEach(id => next.delete(id));
            } else {
                ids.forEach(id => next.add(id));
            }
            return next;
        });
    };

    const toggleType = (typeKey: string) => {
        const typeAccounts = allAccounts.filter(a => a.account_type === typeKey);
        const ids = typeAccounts.flatMap(a => (connectorsByAccount.get(a.id) || []).map(c => c.connector_id));
        const allSelected = ids.length > 0 && ids.every(id => selected.has(id));
        setSelected(prev => {
            const next = new Set(prev);
            if (allSelected) {
                ids.forEach(id => next.delete(id));
            } else {
                ids.forEach(id => next.add(id));
            }
            return next;
        });
    };

    const selectAll = () => {
        setSelected(new Set(allConnectors.map(c => c.connector_id)));
    };

    const clearSelection = () => {
        setSelected(new Set());
    };

    // ── Tri-state helpers ──────────────────────────────────────────────

    const accountCheckState = (accountId: number): { checked: boolean; indeterminate: boolean } => {
        const cps = connectorsByAccount.get(accountId) || [];
        if (cps.length === 0) return { checked: false, indeterminate: false };
        const count = cps.filter(c => selected.has(c.connector_id)).length;
        return { checked: count === cps.length, indeterminate: count > 0 && count < cps.length };
    };



    const typeCheckState = (typeKey: string): { checked: boolean; indeterminate: boolean } => {
        const typeAccounts = allAccounts.filter(a => a.account_type === typeKey);
        const ids = typeAccounts.flatMap(a => (connectorsByAccount.get(a.id) || []).map(c => c.connector_id));
        if (ids.length === 0) return { checked: false, indeterminate: false };
        const count = ids.filter(id => selected.has(id)).length;
        return { checked: count === ids.length, indeterminate: count > 0 && count < ids.length };
    };

    // ── Render ─────────────────────────────────────────────────────────

    return (
        <RadixDialog.Root
            open={isOpen}
            onOpenChange={open => {
                if (!open) onClose();
            }}
        >
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2000] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2000] flex max-h-[85vh] w-full max-w-[950px] -translate-x-1/2 -translate-y-1/2 flex-col bg-white shadow-xl">
                    {/* ── Header ─────────────────────────────── */}
                    <div className="flex items-center justify-between px-6 pb-2 pt-4">
                        <RadixDialog.Title className="text-base font-semibold">
                            Add Accounts & Connectors
                        </RadixDialog.Title>
                        <Badge colorScheme="blue" className="text-xs">
                            {selected.size} selected
                        </Badge>
                    </div>

                    {/* ── Search + Actions ───────────────────── */}
                    <div className="px-6 pb-3">
                        <div className="mb-2 flex items-center gap-2">
                            <div className="relative flex-1">
                                <div className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
                                    <LuSearch size={14} />
                                </div>
                                <Input
                                    className="h-8 pl-8 text-sm"
                                    placeholder="Search accounts, connectors, chains..."
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    autoFocus
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" className="h-6 px-2 text-xs" onClick={selectAll}>
                                Select All
                            </Button>
                            <Button variant="ghost" className="h-6 px-2 text-xs" onClick={clearSelection}>
                                Clear Selection
                            </Button>
                        </div>
                    </div>

                    {/* ── Card grid body ─────────────────────── */}
                    <div className="flex-1 overflow-y-auto px-6">
                        {sections.length === 0 && (
                            <div className="py-8 text-center">
                                <Text className="text-sm text-gray-500">
                                    {searchLower ? 'No accounts or connectors match your search.' : 'No connectors available.'}
                                </Text>
                            </div>
                        )}

                        <div className="flex flex-col gap-3">
                            {sections.map(section => {
                                const typeState = typeCheckState(section.type);

                                return (
                                    <div key={section.type}>
                                        {/* ── Type header ──── */}
                                        <div
                                            className={`mb-2 flex items-center justify-between px-2 py-1.5 ${SECTION_BG[section.colorScheme] || 'bg-gray-50'}`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <Text className="text-sm font-medium">
                                                    {section.emoji} {section.label}
                                                </Text>
                                                <Badge colorScheme="gray" className="text-[10px]">
                                                    {section.accounts.length}
                                                </Badge>
                                            </div>
                                            <TriCheckbox
                                                checked={typeState.checked}
                                                indeterminate={typeState.indeterminate}
                                                onChange={() => toggleType(section.type)}
                                            />
                                        </div>

                                        {/* ── Account cards grid ──── */}
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 px-1">
                                            {section.accounts.map(({ account, connectors, visibleConnectors }) => {
                                                const acctState = accountCheckState(account.id);
                                                const acctColor = getAccountColor(account.id, account.name);
                                                const selectedCount = connectors.filter(c => selected.has(c.connector_id)).length;

                                                return (
                                                    <div
                                                        key={account.id}
                                                        className={`border ${acctState.checked ? 'border-blue-300 bg-blue-50' : acctState.indeterminate ? 'border-blue-200 bg-white' : 'border-gray-200 bg-white'}`}
                                                    >
                                                        {/* Account header */}
                                                        <div
                                                            className="cursor-pointer px-3 py-2 hover:bg-gray-50"
                                                            onClick={() => toggleAccount(account.id)}
                                                        >
                                                            <div className="flex items-center justify-between">
                                                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                                                    <ColorDot color={acctColor} />
                                                                    <div className="flex min-w-0 flex-col items-start gap-0">
                                                                        <Text className="truncate text-sm font-semibold text-gray-700">
                                                                            {account.name}
                                                                        </Text>
                                                                        {account.address_or_identifier && (
                                                                            <Text className="truncate font-mono text-[10px] text-gray-400">
                                                                                {formatAddress(account.address_or_identifier)}
                                                                            </Text>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="flex shrink-0 items-center gap-2">
                                                                    {account.group && (
                                                                        <Badge colorScheme="blue" className="text-[10px]">
                                                                            {account.group}
                                                                        </Badge>
                                                                    )}
                                                                    <Text className="text-[10px] text-gray-400">
                                                                        {selectedCount}/{connectors.length}
                                                                    </Text>
                                                                    <div onClick={e => e.stopPropagation()}>
                                                                        <TriCheckbox
                                                                            checked={acctState.checked}
                                                                            indeterminate={acctState.indeterminate}
                                                                            onChange={() => toggleAccount(account.id)}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Connector list */}
                                                        <div className="px-3 pb-2 pt-0">
                                                            <div className="flex flex-col gap-0">
                                                                {visibleConnectors.map(c => {
                                                                    const cColor = getConnectorColor(c.display_name || c.connector_type);
                                                                    const isChecked = selected.has(c.connector_id);

                                                                    return (
                                                                        <div
                                                                            key={c.connector_id}
                                                                            className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-gray-50"
                                                                            onClick={() => toggleConnector(c.connector_id)}
                                                                        >
                                                                            <TriCheckbox
                                                                                checked={isChecked}
                                                                                indeterminate={false}
                                                                                onChange={() => toggleConnector(c.connector_id)}
                                                                            />
                                                                            <ColorDot color={cColor} size={6} />
                                                                            <Text
                                                                                className={`flex-1 truncate text-xs ${isChecked ? 'text-gray-700' : 'text-gray-400'}`}
                                                                            >
                                                                                {c.display_name || c.connector_type}
                                                                            </Text>
                                                                            {c.is_file_connector && (
                                                                                <Badge colorScheme="blue" className="text-[10px]">📁</Badge>
                                                                            )}
                                                                            {c.chain_name && (
                                                                                <Badge colorScheme="purple" className="text-[10px]">
                                                                                    {formatChainName(c.chain_name)}
                                                                                </Badge>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Footer ─────────────────────────────── */}
                    <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-3">
                        <Button variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            colorScheme="blue"
                            onClick={() => onConfirm(selected)}
                            disabled={selected.size === 0}
                        >
                            Add Selected ({selected.size})
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
