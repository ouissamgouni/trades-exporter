/**
 * TransactionTableRow — Memoized row component for the transactions table.
 *
 * Extracted from TransactionsTable to enable React.memo optimization.
 * When a single cell is edited/hovered, only the affected row re-renders
 * instead of all 50+ rows recreating ~70 inline closures each.
 */

import React from 'react';
import { Badge, Input, type BadgeColorScheme } from './ui/primitives';
import { cn } from '../lib/cn';
import { BiTransfer } from 'react-icons/bi';
import { RiExchangeFundsLine } from 'react-icons/ri';
import { FaQuestion } from 'react-icons/fa';
import { LuPencil, LuPackageX, LuCheck, LuPlus, LuMinus, LuX, LuShieldOff, LuCircleHelp } from 'react-icons/lu';
import { FiCopy, FiPlusCircle } from 'react-icons/fi';
import { LuPackage2 } from 'react-icons/lu';

import { API_URL, Account, Asset, Transaction, TransactionStatus } from '../types';
import { Direction, ReviewStatus, TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../enums';
import { TRANSACTION_TYPE_OPTIONS } from './ComboSelect';
import { AccountSelector } from './AccountSelector';
import { AccountSuggestionBadges } from './AccountSuggestionBadges';
import { AssetBadge } from './AssetBadge';
import { AssetSelector } from './AssetSelector';
import { SourceInfoCell } from './SourceInfoCell';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { ValueDisplay } from './ValueDisplay';
import { BundleSuggestionIcon, SuggestionPopover, BundleMembershipPopover } from './bundles';
import { DuplicateIcon, DuplicatePopover } from './duplicates';
import { getAssetSuggestions, getConfidenceColor, formatConfidence } from '../utils/similarity';
import { formatDateTimeCompact, toDateTimeLocalString, dateTimeLocalToISO } from '../utils/dateUtils';
import { linkRawAccount } from '../utils/rawAccountApi';
import { hasPotentialDuplicateTag, getDuplicateResolutionTag, getDuplicateGroupHash } from '../utils/duplicateTagUtils';
import type { AccountSuggestion } from '../hooks/useAccountSuggestions';
import type { SuggestionEntry } from '../hooks/useBundleSuggestionMap';
import type { DuplicateEntry } from '../hooks/useDuplicateMap';
import type { TransactionColumnKey, ColumnPlugin, RowAction } from './tables';

// Direction options (mirrored from TransactionsTable)
const DIRECTION_OPTIONS = [
    { value: 'inflow', label: '↓' },
    { value: 'outflow', label: '↑' },
    { value: 'internal', label: '↔' }
];

// Direction color mapping is now handled via DIRECTION_ROW_HEX in TransactionsTable.tsx

const statusBadgeColors: Record<TransactionStatus, BadgeColorScheme> = {
    [ReviewStatus.VALID]: 'green',
    [ReviewStatus.PENDING]: 'yellow',
    [ReviewStatus.INVALID]: 'red',
};

// Text color classes for plugin row action buttons, keyed by the plugin's own colorPalette string
const PLUGIN_ACTION_COLORS: Record<string, string> = {
    gray: 'text-slate-500 hover:text-slate-700',
    blue: 'text-blue-500 hover:text-blue-700',
    green: 'text-green-500 hover:text-green-700',
    red: 'text-red-500 hover:text-red-700',
    orange: 'text-orange-500 hover:text-orange-700',
    purple: 'text-purple-500 hover:text-purple-700',
    teal: 'text-teal-500 hover:text-teal-700',
    yellow: 'text-yellow-500 hover:text-yellow-700',
};

// ========== Editable field types (shared with TransactionsTable) ==========
export type EditableField =
    | 'account_id' | 'from_account_id' | 'to_account_id'
    | 'source_transaction_type' | 'direction' | 'transaction_type'
    | 'asset_id' | 'attributed_asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id'
    | 'review_status' | 'review_notes' | 'date_time' | 'source'
    | 'source_asset_symbol' | 'quantity' | 'price' | 'fee'
    | 'user_calculation_unit_id';

// ========== Callback interface (stabilized via useRef in parent) ==========
export interface TransactionRowCallbacks {
    startCellEdit: (tx: Transaction, field: EditableField) => void;
    saveAndClose: () => void;
    updateEditValues: (updates: Partial<Transaction>) => void;
    handleEditKeyDown: (e: React.KeyboardEvent) => void;
    saveFieldDirectly: (txId: number, field: string, value: any) => Promise<void>;
    invalidateTransactionData: () => void;
    refetchAccounts: () => void;
    setEditingCell: (cell: string | null) => void;
    setEditValues: (values: Partial<Transaction>) => void;
    setSelectedIds: React.Dispatch<React.SetStateAction<Set<number>>>;
    setDrawerTransactionId: (id: number | null) => void;
    setIsDrawerOpen: (open: boolean) => void;
    setQuickCreateAccount: (data: any) => void;
    setQuickCreateAsset: (data: any) => void;
    setOpenSuggestionTxId: (id: number | null) => void;
    setHoveredSuggestionGroup: (group: number | null) => void;
    setOpenDuplicateTxId: (id: number | null) => void;
    setHoveredDuplicateGroup: (group: number | null) => void;
    setHoveredBundleId: (id: number | null) => void;
    setOpenBundleTxId: (id: number | null) => void;
    toggleInvalidRow: (id: number) => void;
    refetchAssets: () => void;
    isEditingCell: (txId: number, field: EditableField) => boolean;
    // Additional callbacks
    toggleSelection: (id: number) => void;
    cancelEdit: () => void;
    quickToggle: (tx: Transaction, field: 'include_fee') => Promise<void>;
    getEditingTxId: () => number | null;
    setTransactionToDelete: (tx: Transaction | null) => void;
    fetchDeletionImpact: (ids: number[]) => Promise<void>;
    setShowDeleteDialog: (show: boolean) => void;
    invalidateBundleQueries: () => void;
}

// ========== Props interface ==========
export interface TransactionRowProps {
    tx: Transaction;
    suggestionEntry: SuggestionEntry | undefined;
    duplicateEntry: DuplicateEntry | undefined;
    // Pre-computed row-specific state
    rowBgColor: string;
    rowBorderColor: string;
    isInvalidCollapsed: boolean;
    // Context data
    accounts: Account[];
    accountsById: Map<number, Account>;
    assets: Asset[];
    batchSuggestionsMap: Map<string, AccountSuggestion[]>;
    showColumn: (key: TransactionColumnKey) => boolean;
    visibleColumnCount: number;
    embeddedMode: boolean;
    showSuggestions: boolean;
    showSelectionInEmbedded: boolean;
    // Plugin extensions
    additionalColumns: ColumnPlugin[];
    additionalRowActions: RowAction[];
    // State slices needed by this row
    editingCell: string | null;
    editValues: Partial<Transaction>;
    selectedIds: Set<number>;
    expandedInvalidIds: Set<number>;
    openSuggestionTxId: number | null;
    hoveredSuggestionGroup: number | null;
    openDuplicateTxId: number | null;
    hoveredDuplicateGroup: number | null;
    hoveredBundleId: number | null;
    openBundleTxId: number | null;
    bundleColorMap: Map<number, string>;
    // Refs from parent
    editInputRef: React.RefObject<HTMLInputElement | HTMLSelectElement | null>;
    escapePressedRef: React.MutableRefObject<boolean>;
    editValuesRef: React.MutableRefObject<Partial<Transaction>>;
    // Stable callbacks
    callbacks: TransactionRowCallbacks;
}

// ========== Memoized component ==========
function arePropsEqual(prev: TransactionRowProps, next: TransactionRowProps): boolean {
    if (prev.tx !== next.tx) return false;

    const prevEditingThis = prev.editingCell?.startsWith(`${prev.tx.id}:`);
    const nextEditingThis = next.editingCell?.startsWith(`${next.tx.id}:`);
    if (prevEditingThis !== nextEditingThis) return false;
    if (nextEditingThis && prev.editValues !== next.editValues) return false;
    if (nextEditingThis && prev.editingCell !== next.editingCell) return false;

    if (prev.selectedIds.has(prev.tx.id) !== next.selectedIds.has(next.tx.id)) return false;
    if (prev.rowBgColor !== next.rowBgColor) return false;
    if (prev.isInvalidCollapsed !== next.isInvalidCollapsed) return false;

    const txId = prev.tx.id;
    if ((prev.openSuggestionTxId === txId) !== (next.openSuggestionTxId === txId)) return false;
    if ((prev.openDuplicateTxId === txId) !== (next.openDuplicateTxId === txId)) return false;
    if ((prev.openBundleTxId === txId) !== (next.openBundleTxId === txId)) return false;

    if (prev.expandedInvalidIds.has(txId) !== next.expandedInvalidIds.has(txId)) return false;
    if (prev.accounts !== next.accounts) return false;
    if (prev.accountsById !== next.accountsById) return false;
    if (prev.assets !== next.assets) return false;
    if (prev.bundleColorMap !== next.bundleColorMap) return false;
    if (prev.batchSuggestionsMap !== next.batchSuggestionsMap) return false;
    if (prev.showColumn !== next.showColumn) return false;

    return true;
}

export const TransactionTableRow = React.memo<TransactionRowProps>(function TransactionTableRow(props) {
    const {
        tx, suggestionEntry, duplicateEntry,
        rowBgColor, rowBorderColor, isInvalidCollapsed,
        accounts, accountsById, assets, batchSuggestionsMap,
        showColumn, visibleColumnCount,
        embeddedMode, showSuggestions, showSelectionInEmbedded,
        additionalColumns, additionalRowActions,
        editingCell, editValues,
        selectedIds, expandedInvalidIds,
        openSuggestionTxId, hoveredSuggestionGroup,
        openDuplicateTxId, hoveredDuplicateGroup,
        hoveredBundleId, openBundleTxId, bundleColorMap,
        editInputRef, escapePressedRef, editValuesRef,
        callbacks,
    } = props;

    const {
        startCellEdit, saveAndClose, updateEditValues, handleEditKeyDown,
        saveFieldDirectly, invalidateTransactionData, refetchAccounts,
        setEditingCell, setEditValues, setSelectedIds,
        setDrawerTransactionId, setIsDrawerOpen,
        setQuickCreateAccount, setQuickCreateAsset,
        setOpenSuggestionTxId, setHoveredSuggestionGroup,
        setOpenDuplicateTxId, setHoveredDuplicateGroup,
        setHoveredBundleId, setOpenBundleTxId,
        toggleInvalidRow, refetchAssets, isEditingCell,
        toggleSelection, cancelEdit, quickToggle, getEditingTxId,
        setTransactionToDelete, fetchDeletionImpact, setShowDeleteDialog,
        invalidateBundleQueries,
    } = callbacks;

    // ============== Collapsed Invalid Row ==============
    if (isInvalidCollapsed) {
        return (
            <tr
                key={tx.id}
                className="h-5 cursor-pointer bg-slate-200 hover:bg-slate-300"
                onClick={() => toggleInvalidRow(tx.id)}
            >
                <td colSpan={visibleColumnCount} className="relative p-0">
                    {/* Red status band on far left */}
                    <div className="absolute bottom-0 left-0 top-0 w-1 bg-red-500" />
                    <div className="flex min-h-[20px] items-center gap-2 py-0 pl-[10px] pr-2">
                        <button
                            type="button"
                            title="Expand invalid row"
                            className="flex shrink-0 items-center text-slate-400 hover:text-red-500"
                            onClick={(e: React.MouseEvent) => {
                                e.stopPropagation();
                                toggleInvalidRow(tx.id);
                            }}
                        >
                            <LuPlus size={11} />
                        </button>
                        <Badge colorScheme="red" className="px-1 text-[7px]">
                            <LuX size={8} /> Invalid
                        </Badge>
                        <span className="max-w-[200px] truncate text-[7px] text-slate-400">
                            {formatDateTimeCompact(tx.date_time)} · {tx.source_asset_symbol || tx.linked_asset?.symbol || '—'}
                            {tx.source ? ` · ${tx.source}` : ''}
                        </span>
                    </div>
                </td>
            </tr>
        );
    }

    // ============== Normal / Expanded Row ==============
    return (
        <React.Fragment key={tx.id}>
            <tr
                className="group bg-[var(--row-bg)] transition-colors hover:bg-blue-50"
                style={{ ['--row-bg' as string]: rowBgColor } as React.CSSProperties}
                onMouseEnter={() => {
                    if (suggestionEntry) setHoveredSuggestionGroup(suggestionEntry.groupIndex);
                    if (tx.user_calculation_unit_id && !suggestionEntry) setHoveredBundleId(tx.user_calculation_unit_id);
                    if (duplicateEntry) setHoveredDuplicateGroup(duplicateEntry.groupIndex);
                }}
                onMouseLeave={() => {
                    if (suggestionEntry) setHoveredSuggestionGroup(null);
                    if (tx.user_calculation_unit_id && !suggestionEntry) setHoveredBundleId(null);
                    if (duplicateEntry) setHoveredDuplicateGroup(null);
                }}
            >
                <td className="sticky left-0 z-[5] border-r-2 border-slate-300 bg-[var(--row-bg)] p-0 group-hover:bg-blue-50">
                    {/* Review status band — full cell height */}
                    <div className="absolute bottom-0 left-0 top-0 w-1" style={{ backgroundColor: rowBorderColor }} />
                    {/* Suggestion / Bundle color band — right next to review status (mutually exclusive) */}
                    {suggestionEntry ? (
                        <div className="absolute bottom-0 top-0 z-[1] w-1" style={{ left: '5px', backgroundColor: suggestionEntry.color }} />
                    ) : (tx.user_calculation_unit_id != null) ? (
                        <div className="absolute bottom-0 top-0 z-[1] w-1" style={{ left: '5px', backgroundColor: bundleColorMap.get(tx.user_calculation_unit_id) || '#c084fc' }} />
                    ) : null}
                    {/* Duplicate band (Band 3) — right of suggestion/bundle band */}
                    {duplicateEntry && (
                        <div className="absolute bottom-0 top-0 z-[1] w-1" style={{ left: '10px', backgroundColor: duplicateEntry.color }} />
                    )}
                    <div className="flex min-h-[28px] max-w-[92px] flex-wrap items-center gap-1 pr-1" style={{ paddingLeft: duplicateEntry ? '17px' : (suggestionEntry || tx.user_calculation_unit_id) ? '12px' : '7px' }}>
                        {/* Duplicate icon — clickable, opens popover */}
                        {duplicateEntry && (
                            <DuplicatePopover
                                groupHash={duplicateEntry.groupHash}
                                transactionIds={duplicateEntry.transactionIds}
                                matchCriteria={duplicateEntry.matchCriteria}
                                open={openDuplicateTxId === tx.id}
                                onOpenChange={(open) => setOpenDuplicateTxId(open ? tx.id : null)}
                                onTransactionClick={(txId) => {
                                    setDrawerTransactionId(txId);
                                    setIsDrawerOpen(true);
                                }}
                            >
                                <button
                                    type="button"
                                    className="flex cursor-pointer items-center p-0 hover:opacity-70"
                                    style={{ color: duplicateEntry.color }}
                                    title={`Duplicate suspicion: ${duplicateEntry.matchCriteria}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    <DuplicateIcon size={11} />
                                </button>
                            </DuplicatePopover>
                        )}
                        {/* Suggestion band icon — clickable, opens popover */}
                        {suggestionEntry && (
                            <SuggestionPopover
                                suggestion={suggestionEntry.suggestion}
                                open={openSuggestionTxId === tx.id}
                                onOpenChange={(open) => setOpenSuggestionTxId(open ? tx.id : null)}
                                onAccepted={() => setOpenSuggestionTxId(null)}
                                onDismissed={() => setOpenSuggestionTxId(null)}
                                onTransactionClick={(txId) => {
                                    setDrawerTransactionId(txId);
                                    setIsDrawerOpen(true);
                                }}
                            >
                                <button
                                    type="button"
                                    className="flex cursor-pointer items-center p-0 hover:opacity-70"
                                    style={{ color: suggestionEntry.color }}
                                    title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    <BundleSuggestionIcon size={12} />
                                </button>
                            </SuggestionPopover>
                        )}
                        {/* Bundle membership badge — clickable, opens popover */}
                        {!suggestionEntry && tx.user_calculation_unit_id && (
                            <BundleMembershipPopover
                                bundleId={tx.user_calculation_unit_id}
                                color={bundleColorMap.get(tx.user_calculation_unit_id) || '#c084fc'}
                                open={openBundleTxId === tx.id}
                                onOpenChange={(open) => setOpenBundleTxId(open ? tx.id : null)}
                                onTransactionClick={(txId) => {
                                    setDrawerTransactionId(txId);
                                    setIsDrawerOpen(true);
                                }}
                            >
                                <Badge
                                    colorScheme="purple"
                                    className="cursor-pointer text-[7px] hover:opacity-70"
                                    title={`Bundle #${tx.user_calculation_unit_id}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    📦 #{tx.user_calculation_unit_id}
                                </Badge>
                            </BundleMembershipPopover>
                        )}
                        {/* Collapse toggle for expanded invalid rows */}
                        {tx.review_status === 'invalid' && expandedInvalidIds.has(tx.id) && (
                            <button
                                type="button"
                                className="flex shrink-0 items-center p-0 text-red-400 hover:text-red-600"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    toggleInvalidRow(tx.id);
                                }}
                                title="Collapse invalid row"
                            >
                                <LuMinus size={11} />
                            </button>
                        )}
                        {(!embeddedMode || showSelectionInEmbedded) && (
                            <input
                                type="checkbox"
                                title="Select row"
                                className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                checked={selectedIds.has(tx.id)}
                                onChange={() => toggleSelection(tx.id)}
                            />
                        )}
                        {/* TX ID - clickable to open drawer */}
                        <span
                            className="cursor-pointer font-mono text-[8px] text-slate-400 hover:text-blue-500 hover:underline"
                            onClick={() => {
                                setDrawerTransactionId(tx.id);
                                setIsDrawerOpen(true);
                            }}
                            title={`TX #${tx.id} — Click to view details`}
                        >
                            #{tx.id}
                        </span>
                    </div>
                </td>
                {showColumn('id') && (
                    <td className="py-1">
                        <span className="font-mono text-[8px] text-slate-500">{tx.id}</span>
                    </td>
                )}
                {/* Date/Time - click to edit */}
                {showColumn('date') && (
                    <td className="cursor-pointer py-1 pr-1" onClick={() => !isEditingCell(tx.id, 'date_time') && startCellEdit(tx, 'date_time')}>
                        {isEditingCell(tx.id, 'date_time') ? (
                            <Input
                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                type="datetime-local"
                                value={toDateTimeLocalString(editValues.date_time)}
                                onChange={e => updateEditValues({ date_time: e.target.value })}
                                onKeyDown={handleEditKeyDown}
                                onBlur={saveAndClose}
                                className="w-[130px] px-1 text-[8px]"
                            />
                        ) : (
                            <span className="text-[8px]">{formatDateTimeCompact(tx.date_time)}</span>
                        )}
                    </td>
                )}
                {/* Source Info - merged column with Source Account, Source, Source Type, Source Symbol */}
                {showColumn('source') && (
                    <td className="cursor-pointer py-1 pr-1">
                        {isEditingCell(tx.id, 'account_id') ? (
                            <div className="flex min-w-[120px] flex-col gap-1">
                                <AccountSelector
                                    value={editValues.account_id ?? null}
                                    onChange={(accountId) => {
                                        if (!escapePressedRef.current) {
                                            updateEditValues({ account_id: accountId ?? undefined });
                                            saveAndClose();
                                        }
                                    }}
                                    accounts={accounts}
                                    onAccountCreated={refetchAccounts}
                                    defaultName={tx.source_account || ''}
                                    placeholder="Link account..."
                                    rawAccountSource={tx.source}
                                    rawAccountLabel={tx.source_account}
                                    rawAccountNetwork={tx.network || undefined}
                                />
                                {/* Show account suggestions below the selector when editing */}
                                {tx.source_account && !tx.account_id && (
                                    <AccountSuggestionBadges
                                        label={tx.source_account}
                                        source={tx.source}
                                        network={tx.network}
                                        showLabel
                                        suggestions={batchSuggestionsMap.get(tx.source_account!) ?? []}
                                        onAccept={(s) => {
                                            updateEditValues({ account_id: s.id });
                                            saveAndClose();
                                        }}
                                    />
                                )}
                                {/* Secondary info shown when editing */}
                                <span className="text-[7px] text-slate-400">
                                    {[tx.source, tx.source_transaction_type].filter(Boolean).join(' · ')}
                                </span>
                            </div>
                        ) : (
                            <SourceInfoCell
                                sourceAccount={tx.source_account}
                                accountId={tx.account_id}
                                resolvedAccount={accountsById.get(tx.account_id!)}
                                resolvedAccountName={accountsById.get(tx.account_id!)?.name}
                                accountSuggestions={batchSuggestionsMap.get(tx.source_account ?? '') ?? []}
                                source={tx.source}
                                sourceType={tx.source_transaction_type}
                                sourceSymbol={tx.source_asset_symbol}
                                sourceTransactionId={tx.source_transaction_id}
                                connectorName={tx.connector_name}
                                runDatetime={tx.run_datetime}
                                syncConnectorRunId={tx.sync_connector_run_id}
                                network={tx.network}
                                onClick={() => startCellEdit(tx, 'account_id')}
                                onCreateAccount={!tx.account_id && tx.source_account ? () => {
                                    setQuickCreateAccount({
                                        txId: tx.id,
                                        field: 'account_id',
                                        prefill: {
                                            name: tx.source_account || '',
                                            account_type: tx.source_account?.startsWith('0x') ? 'wallet' : 'cex',
                                            address_or_identifier: tx.source_account || '',
                                        },
                                        rawSource: tx.source,
                                        rawLabel: tx.source_account || undefined,
                                        rawNetwork: tx.network || undefined,
                                    });
                                } : undefined}
                                onAcceptSuggestion={async (accountId) => {
                                    try {
                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ account_id: accountId })
                                        });
                                        if (!response.ok) throw new Error('Failed to update');
                                        // Also link the raw_account with network
                                        if (tx.source_account) {
                                            try {
                                                await linkRawAccount({
                                                    source: tx.source,
                                                    label: tx.source_account,
                                                    network: tx.network || undefined,
                                                    accountId,
                                                });
                                            } catch (linkErr) {
                                                console.warn('Failed to link raw account:', linkErr);
                                            }
                                        }
                                        invalidateTransactionData();
                                    } catch (err) {
                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                    }
                                }}
                            />
                        )}
                    </td>
                )}
                {/* From / To Accounts - merged column showing both in 2 lines with inline editing */}
                {showColumn('accounts') && (
                    <td className="py-1">
                        <div className="flex flex-col items-center gap-0.5">
                            {/* From Account - editable */}
                            {isEditingCell(tx.id, 'from_account_id') ? (
                                <div className="flex min-w-[100px] flex-col gap-1">
                                    <AccountSelector
                                        value={editValues.from_account_id ?? null}
                                        onChange={async (accountId) => {
                                            if (!escapePressedRef.current) {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ from_account_id: accountId })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    invalidateTransactionData();
                                                    setEditingCell(null);
                                                    setEditValues({});
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }
                                        }}
                                        accounts={accounts}
                                        onAccountCreated={refetchAccounts}
                                        defaultName={tx.source_from_account || ''}
                                        placeholder="From..."
                                        size="sm"
                                        rawAccountSource={tx.source}
                                        rawAccountLabel={tx.source_from_account}
                                        rawAccountNetwork={tx.network || undefined}
                                    />
                                    {/* Suggestion badges when editing */}
                                    {tx.source_from_account && !tx.from_account_id && (
                                        <AccountSuggestionBadges
                                            label={tx.source_from_account}
                                            source={tx.source}
                                            network={tx.network}
                                            fontSize="6px"
                                            suggestions={batchSuggestionsMap.get(tx.source_from_account!) ?? []}
                                            onAccept={async (s) => {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ from_account_id: s.id })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    invalidateTransactionData();
                                                    setEditingCell(null);
                                                    setEditValues({});
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }}
                                        />
                                    )}
                                </div>
                            ) : (tx.from_account_id || tx.source_from_account) ? (
                                <div className="flex flex-col items-start gap-0.5">
                                    <div className="flex items-center gap-0.5">
                                        <Tooltip
                                            content={
                                                tx.from_account_id
                                                    ? `From: ${tx.from_account_name || 'Account'}${tx.source_from_account ? ` — Source: ${tx.source_from_account}` : ''} — Click to edit`
                                                    : `From: ${tx.source_from_account} - Click to link`
                                            }
                                            openDelay={200}
                                        >
                                            <Badge
                                                colorScheme={tx.from_account_id ? 'blue' : 'orange'}
                                                className="cursor-pointer text-[8px] px-1 py-0"
                                                onClick={() => startCellEdit(tx, 'from_account_id')}
                                            >
                                                {tx.from_account_id ? (
                                                    (tx.from_account_name || `#${tx.from_account_id}`).slice(0, 10)
                                                ) : (
                                                    <>⚠ {(tx.source_from_account || '').slice(0, 8)}{(tx.source_from_account || '').length > 8 && '…'}</>
                                                )}
                                            </Badge>
                                        </Tooltip>
                                        {tx.from_account_id && (
                                            <Tooltip content="Clear from account" openDelay={100}>
                                                <button
                                                    type="button"
                                                    onClick={async (e: React.MouseEvent) => {
                                                        e.stopPropagation();
                                                        try {
                                                            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                method: 'PATCH',
                                                                headers: { 'Content-Type': 'application/json' },
                                                                body: JSON.stringify({ from_account_id: null })
                                                            });
                                                            if (!response.ok) throw new Error('Failed to clear');
                                                            invalidateTransactionData();
                                                        } catch (err) {
                                                            toaster.error({ title: 'Error', description: 'Failed to clear from account' });
                                                        }
                                                    }}
                                                    className="flex shrink-0 cursor-pointer items-center text-red-400 hover:text-red-600"
                                                >
                                                    <LuX size={10} />
                                                </button>
                                            </Tooltip>
                                        )}
                                        {!tx.from_account_id && tx.source_from_account && (
                                            <Tooltip content="Create new account" openDelay={100}>
                                                <button
                                                    type="button"
                                                    onClick={(e: React.MouseEvent) => {
                                                        e.stopPropagation();
                                                        setQuickCreateAccount({
                                                            txId: tx.id,
                                                            field: 'from_account_id',
                                                            prefill: {
                                                                name: tx.source_from_account || '',
                                                                account_type: tx.source_from_account?.startsWith('0x') ? 'wallet' : 'cex',
                                                                address_or_identifier: tx.source_from_account || '',
                                                            },
                                                            rawSource: tx.source,
                                                            rawLabel: tx.source_from_account || undefined,
                                                            rawNetwork: tx.network || undefined,
                                                        });
                                                    }}
                                                    className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                                >
                                                    <FiPlusCircle size={10} />
                                                </button>
                                            </Tooltip>
                                        )}
                                    </div>
                                    {/* Always-visible suggestion badges for unlinked from_account */}
                                    {tx.source_from_account && !tx.from_account_id && (
                                        <AccountSuggestionBadges
                                            label={tx.source_from_account}
                                            source={tx.source}
                                            network={tx.network}
                                            maxResults={2}
                                            fontSize="6px"
                                            suggestions={batchSuggestionsMap.get(tx.source_from_account!) ?? []}
                                            onAccept={async (s) => {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ from_account_id: s.id })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    // Also link the raw_account
                                                    if (tx.source_from_account) {
                                                        try {
                                                            await linkRawAccount({ source: tx.source, label: tx.source_from_account, network: tx.network, accountId: s.id });
                                                        } catch { }
                                                    }
                                                    invalidateTransactionData();
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }}
                                        />
                                    )}
                                </div>
                            ) : (
                                <Badge
                                    colorScheme="gray"
                                    className="cursor-pointer border border-slate-300 bg-white text-[8px] px-1 py-0 text-slate-500"
                                    onClick={() => startCellEdit(tx, 'from_account_id')}
                                >
                                    + From
                                </Badge>
                            )}
                            {/* Arrow separator between from and to */}
                            <span className="text-[10px] leading-none text-slate-400">↓</span>
                            {/* To Account - editable */}
                            {isEditingCell(tx.id, 'to_account_id') ? (
                                <div className="flex min-w-[100px] flex-col gap-1">
                                    <AccountSelector
                                        value={editValues.to_account_id ?? null}
                                        onChange={async (accountId) => {
                                            if (!escapePressedRef.current) {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ to_account_id: accountId })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    invalidateTransactionData();
                                                    setEditingCell(null);
                                                    setEditValues({});
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }
                                        }}
                                        accounts={accounts}
                                        onAccountCreated={refetchAccounts}
                                        defaultName={tx.source_to_account || ''}
                                        placeholder="To..."
                                        size="sm"
                                        rawAccountSource={tx.source}
                                        rawAccountLabel={tx.source_to_account}
                                        rawAccountNetwork={tx.network || undefined}
                                    />
                                    {/* Suggestion badges when editing */}
                                    {tx.source_to_account && !tx.to_account_id && (
                                        <AccountSuggestionBadges
                                            label={tx.source_to_account}
                                            source={tx.source}
                                            network={tx.network}
                                            fontSize="6px"
                                            suggestions={batchSuggestionsMap.get(tx.source_to_account!) ?? []}
                                            onAccept={async (s) => {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ to_account_id: s.id })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    invalidateTransactionData();
                                                    setEditingCell(null);
                                                    setEditValues({});
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }}
                                        />
                                    )}
                                </div>
                            ) : (tx.to_account_id || tx.source_to_account) ? (
                                <div className="flex flex-col items-start gap-0.5">
                                    <div className="flex items-center gap-0.5">
                                        <Tooltip
                                            content={
                                                tx.to_account_id
                                                    ? `To: ${tx.to_account_name || 'Account'}${tx.source_to_account ? ` — Source: ${tx.source_to_account}` : ''} — Click to edit`
                                                    : `To: ${tx.source_to_account} - Click to link`
                                            }
                                            openDelay={200}
                                        >
                                            <Badge
                                                colorScheme={tx.to_account_id ? 'blue' : 'orange'}
                                                className="cursor-pointer text-[8px] px-1 py-0"
                                                onClick={() => startCellEdit(tx, 'to_account_id')}
                                            >
                                                {tx.to_account_id ? (
                                                    (tx.to_account_name || `#${tx.to_account_id}`).slice(0, 10)
                                                ) : (
                                                    <>⚠ {(tx.source_to_account || '').slice(0, 8)}{(tx.source_to_account || '').length > 8 && '…'}</>
                                                )}
                                            </Badge>
                                        </Tooltip>
                                        {tx.to_account_id && (
                                            <Tooltip content="Clear to account" openDelay={100}>
                                                <button
                                                    type="button"
                                                    onClick={async (e: React.MouseEvent) => {
                                                        e.stopPropagation();
                                                        try {
                                                            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                method: 'PATCH',
                                                                headers: { 'Content-Type': 'application/json' },
                                                                body: JSON.stringify({ to_account_id: null })
                                                            });
                                                            if (!response.ok) throw new Error('Failed to clear');
                                                            invalidateTransactionData();
                                                        } catch (err) {
                                                            toaster.error({ title: 'Error', description: 'Failed to clear to account' });
                                                        }
                                                    }}
                                                    className="flex shrink-0 cursor-pointer items-center text-red-400 hover:text-red-600"
                                                >
                                                    <LuX size={10} />
                                                </button>
                                            </Tooltip>
                                        )}
                                        {!tx.to_account_id && tx.source_to_account && (
                                            <Tooltip content="Create new account" openDelay={100}>
                                                <button
                                                    type="button"
                                                    onClick={(e: React.MouseEvent) => {
                                                        e.stopPropagation();
                                                        setQuickCreateAccount({
                                                            txId: tx.id,
                                                            field: 'to_account_id',
                                                            prefill: {
                                                                name: tx.source_to_account || '',
                                                                account_type: tx.source_to_account?.startsWith('0x') ? 'wallet' : 'cex',
                                                                address_or_identifier: tx.source_to_account || '',
                                                            },
                                                            rawSource: tx.source,
                                                            rawLabel: tx.source_to_account || undefined,
                                                            rawNetwork: tx.network || undefined,
                                                        });
                                                    }}
                                                    className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                                >
                                                    <FiPlusCircle size={10} />
                                                </button>
                                            </Tooltip>
                                        )}
                                    </div>
                                    {/* Always-visible suggestion badges for unlinked to_account */}
                                    {tx.source_to_account && !tx.to_account_id && (
                                        <AccountSuggestionBadges
                                            label={tx.source_to_account}
                                            source={tx.source}
                                            network={tx.network}
                                            maxResults={2}
                                            fontSize="6px"
                                            suggestions={batchSuggestionsMap.get(tx.source_to_account!) ?? []}
                                            onAccept={async (s) => {
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ to_account_id: s.id })
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    // Also link the raw_account
                                                    if (tx.source_to_account) {
                                                        try {
                                                            await linkRawAccount({ source: tx.source, label: tx.source_to_account, network: tx.network, accountId: s.id });
                                                        } catch { }
                                                    }
                                                    invalidateTransactionData();
                                                } catch (err) {
                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                }
                                            }}
                                        />
                                    )}
                                </div>
                            ) : (
                                <Badge
                                    colorScheme="gray"
                                    className="cursor-pointer border border-slate-300 bg-white text-[8px] px-1 py-0 text-slate-500"
                                    onClick={() => startCellEdit(tx, 'to_account_id')}
                                >
                                    + To
                                </Badge>
                            )}
                        </div>
                    </td>
                )}
                {/* Direction - click to edit */}
                {showColumn('direction') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'direction') && startCellEdit(tx, 'direction')}>
                        {isEditingCell(tx.id, 'direction') ? (
                            <select
                                title="Direction"
                                className="w-[45px] border border-slate-300 text-[8px]"
                                value={editValues.direction || tx.direction}
                                onChange={async e => {
                                    const newDir = e.target.value;
                                    // Save directly with the new value
                                    try {
                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ direction: newDir })
                                        });
                                        if (!response.ok) throw new Error('Failed to update');
                                        invalidateTransactionData();
                                        setEditingCell(null);
                                        setEditValues({});
                                    } catch (err) {
                                        toaster.error({ title: 'Error', description: 'Failed to save direction' });
                                    }
                                }}
                                onBlur={() => {
                                    if (!escapePressedRef.current) {
                                        setEditingCell(null);
                                        setEditValues({});
                                    }
                                }}
                                style={{ fontSize: '8px', padding: '2px' }}
                                autoFocus
                            >
                                {DIRECTION_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        ) : (
                            <Badge colorScheme={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}>
                                {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                            </Badge>
                        )}
                    </td>
                )}
                {/* Type - click to edit */}
                {showColumn('type') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'transaction_type') && startCellEdit(tx, 'transaction_type')}>
                        {isEditingCell(tx.id, 'transaction_type') ? (
                            <select
                                title="Transaction type"
                                className="w-[80px] border border-slate-300 text-[8px]"
                                value={editValues.transaction_type || tx.transaction_type}
                                onChange={async e => {
                                    const newType = e.target.value;
                                    try {
                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ transaction_type: newType })
                                        });
                                        if (!response.ok) throw new Error('Failed to update');
                                        invalidateTransactionData();
                                        setEditingCell(null);
                                        setEditValues({});
                                    } catch (err) {
                                        toaster.error({ title: 'Error', description: 'Failed to save type' });
                                    }
                                }}
                                onBlur={() => {
                                    if (!escapePressedRef.current) {
                                        setEditingCell(null);
                                        setEditValues({});
                                    }
                                }}
                                style={{ fontSize: '8px', padding: '2px' }}
                                autoFocus
                            >
                                {TRANSACTION_TYPE_OPTIONS.map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        ) : (
                            <div className="flex items-center gap-1">
                                {tx.transaction_type === 'transfer' ? (
                                    <BiTransfer color="#805AD5" size={12} title="Transfer" />
                                ) : tx.transaction_type === 'trade' ? (
                                    <RiExchangeFundsLine color="#3182CE" size={12} title="Trade" />
                                ) : tx.transaction_type === 'margin' ? (
                                    <RiExchangeFundsLine color="#D69E2E" size={12} title="Margin (derivative)" />
                                ) : tx.transaction_type === 'cost' ? (
                                    <FaQuestion color="#A0AEC0" size={10} title="Cost (fee-only)" />
                                ) : (
                                    <FaQuestion color="#718096" size={10} title="Other" />
                                )}
                                <Badge colorScheme="blue" className="text-[10px]">{tx.transaction_type?.substring(0, 6)}</Badge>
                            </div>
                        )}
                    </td>
                )}
                {/* Linked Asset - click to edit */}
                {showColumn('asset') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'asset_id') && !isEditingCell(tx.id, 'attributed_asset_id') && startCellEdit(tx, 'asset_id')}>
                        <div className="flex flex-col gap-0.5">
                            {isEditingCell(tx.id, 'asset_id') ? (
                                <div className="flex min-w-[90px] flex-col gap-1">
                                    <AssetSelector
                                        value={editValues.asset_id ?? null}
                                        onChange={(assetId) => {
                                            if (!escapePressedRef.current) {
                                                updateEditValues({ asset_id: assetId ?? undefined });
                                                saveAndClose();
                                            }
                                        }}
                                        assets={assets}
                                        onAssetCreated={refetchAssets}
                                        defaultSymbol={tx.source_asset_symbol || ''}
                                        placeholder="Link..."
                                        rawAssetSource={tx.source}
                                        rawAssetSymbol={tx.source_asset_symbol}
                                    />
                                    {/* Show asset suggestions when editing unlinked asset */}
                                    {tx.source_asset_symbol && !tx.asset_id && (() => {
                                        const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 3);
                                        return suggestions.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                <span className="text-[7px] text-slate-500">Suggestions:</span>
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className={cn('cursor-pointer text-[7px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                updateEditValues({ asset_id: s.item.asset_id });
                                                                saveAndClose();
                                                            }}
                                                        >
                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}
                                                            {s.confidence >= 0.9 && ' ✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                            ) : (
                                tx.linked_asset_symbol ? (
                                    <AssetBadge
                                        asset={tx.linked_asset}
                                        size="sm"
                                        colorPalette="purple"
                                        maxLength={10}
                                        onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}
                                    />
                                ) : tx.source_asset_symbol ? (
                                    <div className="flex flex-col items-start gap-0.5">
                                        <div className="flex items-center gap-0.5">
                                            <Tooltip content={`${tx.source_asset_symbol} - Click to link`} openDelay={200}>
                                                <span className="cursor-pointer text-[8px] font-bold text-orange-500" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}>
                                                    ⚠ {tx.source_asset_symbol.slice(0, 8)}{tx.source_asset_symbol.length > 8 && '…'}
                                                </span>
                                            </Tooltip>
                                            <Tooltip content="Create new asset" openDelay={100}>
                                                <button
                                                    type="button"
                                                    onClick={(e: React.MouseEvent) => {
                                                        e.stopPropagation();
                                                        setQuickCreateAsset({
                                                            txId: tx.id,
                                                            field: 'asset_id',
                                                            prefill: { symbol: tx.source_asset_symbol || '' },
                                                            rawSource: tx.source,
                                                            rawSymbol: tx.source_asset_symbol || undefined,
                                                        });
                                                    }}
                                                    className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                                >
                                                    <FiPlusCircle size={10} />
                                                </button>
                                            </Tooltip>
                                        </div>
                                        {/* Always-visible suggestion badges for unlinked asset */}
                                        {(() => {
                                            const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 2);
                                            return suggestions.length > 0 ? (
                                                <div className="flex flex-wrap gap-0.5">
                                                    {suggestions.map((s, idx) => (
                                                        <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                            <Badge
                                                                colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                                onClick={async (e) => {
                                                                    e.stopPropagation();
                                                                    try {
                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                            method: 'PATCH',
                                                                            headers: { 'Content-Type': 'application/json' },
                                                                            body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                        });
                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                        // Also link the raw_asset
                                                                        if (tx.source_asset_symbol) {
                                                                            try {
                                                                                await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_asset_symbol)}`, {
                                                                                    method: 'PATCH',
                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                    body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                });
                                                                            } catch { }
                                                                        }
                                                                        invalidateTransactionData();
                                                                    } catch (err) {
                                                                        toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                    }
                                                                }}
                                                            >
                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                            </Badge>
                                                        </Tooltip>
                                                    ))}
                                                </div>
                                            ) : null;
                                        })()}
                                    </div>
                                ) : (
                                    <span className="text-[8px] text-slate-400">-</span>
                                )
                            )}
                            {/* Attributed asset badge with inline editing */}
                            {(tx.source_attributed_asset_symbol || tx.attributed_asset_id) && (
                                isEditingCell(tx.id, 'attributed_asset_id') ? (
                                    <div className="flex min-w-[90px] flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
                                        <span className="text-[7px] text-slate-500">Attr. asset:</span>
                                        <AssetSelector
                                            value={editValues.attributed_asset_id ?? null}
                                            onChange={(assetId) => {
                                                if (!escapePressedRef.current) {
                                                    updateEditValues({ attributed_asset_id: assetId ?? undefined });
                                                    saveAndClose();
                                                }
                                            }}
                                            assets={assets}
                                            onAssetCreated={refetchAssets}
                                            defaultSymbol={tx.source_attributed_asset_symbol || ''}
                                            placeholder="Link attributed..."
                                            rawAssetSource={tx.source}
                                            rawAssetSymbol={tx.source_attributed_asset_symbol}
                                        />
                                        {tx.source_attributed_asset_symbol && !tx.attributed_asset_id && (() => {
                                            const suggestions = getAssetSuggestions(tx.source_attributed_asset_symbol, assets, 0.5, 3);
                                            return suggestions.length > 0 ? (
                                                <div className="flex flex-wrap gap-1">
                                                    <span className="text-[7px] text-slate-500">Suggestions:</span>
                                                    {suggestions.map((s, idx) => (
                                                        <Tooltip
                                                            key={idx}
                                                            content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                            openDelay={100}
                                                        >
                                                            <Badge
                                                                colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                className={cn('cursor-pointer text-[7px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    updateEditValues({ attributed_asset_id: s.item.asset_id });
                                                                    saveAndClose();
                                                                }}
                                                            >
                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}
                                                                {s.confidence >= 0.9 && ' ✓'}
                                                            </Badge>
                                                        </Tooltip>
                                                    ))}
                                                </div>
                                            ) : null;
                                        })()}
                                    </div>
                                ) : (
                                    tx.attributed_asset_id && tx.attributed_asset ? (
                                        <div className="flex cursor-pointer items-center gap-0.5" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'attributed_asset_id'); }}>
                                            <span className="text-[7px] text-slate-500">→</span>
                                            <AssetBadge
                                                asset={tx.attributed_asset}
                                                size="xs"
                                                colorPalette="orange"
                                                maxLength={8}
                                            />
                                        </div>
                                    ) : tx.source_attributed_asset_symbol ? (
                                        <div className="flex flex-col items-start gap-0.5" onClick={(e) => e.stopPropagation()}>
                                            <div className="flex items-center gap-0.5">
                                                <span className="text-[7px] text-slate-500">→</span>
                                                <Tooltip content={`${tx.source_attributed_asset_symbol} - Click to link attributed asset`} openDelay={200}>
                                                    <span className="cursor-pointer text-[7px] font-bold text-orange-500" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'attributed_asset_id'); }}>
                                                        ⚠ {tx.source_attributed_asset_symbol.slice(0, 6)}{tx.source_attributed_asset_symbol.length > 6 && '…'}
                                                    </span>
                                                </Tooltip>
                                                <Tooltip content="Create new asset" openDelay={100}>
                                                    <button
                                                        type="button"
                                                        onClick={(e: React.MouseEvent) => {
                                                            e.stopPropagation();
                                                            setQuickCreateAsset({
                                                                txId: tx.id,
                                                                field: 'attributed_asset_id',
                                                                prefill: { symbol: tx.source_attributed_asset_symbol || '' },
                                                                rawSource: tx.source,
                                                                rawSymbol: tx.source_attributed_asset_symbol || undefined,
                                                            });
                                                        }}
                                                        className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                                    >
                                                        <FiPlusCircle size={8} />
                                                    </button>
                                                </Tooltip>
                                            </div>
                                            {(() => {
                                                const suggestions = getAssetSuggestions(tx.source_attributed_asset_symbol, assets, 0.5, 2);
                                                return suggestions.length > 0 ? (
                                                    <div className="flex flex-wrap gap-0.5">
                                                        {suggestions.map((s, idx) => (
                                                            <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                <Badge
                                                                    colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                    className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                                    onClick={async (e) => {
                                                                        e.stopPropagation();
                                                                        try {
                                                                            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                method: 'PATCH',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ attributed_asset_id: s.item.asset_id })
                                                                            });
                                                                            if (!response.ok) throw new Error('Failed to update');
                                                                            if (tx.source_attributed_asset_symbol) {
                                                                                try {
                                                                                    await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_attributed_asset_symbol)}`, {
                                                                                        method: 'PATCH',
                                                                                        headers: { 'Content-Type': 'application/json' },
                                                                                        body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                    });
                                                                                } catch { }
                                                                            }
                                                                            invalidateTransactionData();
                                                                        } catch (err) {
                                                                            toaster.error({ title: 'Error', description: 'Failed to link attributed asset' });
                                                                        }
                                                                    }}
                                                                >
                                                                    {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                </Badge>
                                                            </Tooltip>
                                                        ))}
                                                    </div>
                                                ) : null;
                                            })()}
                                        </div>
                                    ) : null
                                )
                            )}
                        </div>
                    </td>
                )}
                {/* Quantity - click to edit */}
                {showColumn('qty') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'quantity') && startCellEdit(tx, 'quantity')}>
                        {isEditingCell(tx.id, 'quantity') ? (
                            <Input
                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                type="number"
                                step="any"
                                value={editValues.quantity ?? tx.quantity ?? ''}
                                onChange={e => updateEditValues({ quantity: parseFloat(e.target.value) || 0 })}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                    else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity); }
                                }}
                                onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity)}
                                className="w-[60px] px-1 text-[8px]"
                            />
                        ) : (
                            <span className="text-[8px]"><ValueDisplay value={tx.quantity} /></span>
                        )}
                    </td>
                )}
                {/* Price - click to edit value, click badge to edit quote asset */}
                {showColumn('price') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'price') && !isEditingCell(tx.id, 'price_quote_asset_id') && startCellEdit(tx, 'price')}>
                        <div className="flex flex-col gap-0">
                            {isEditingCell(tx.id, 'price') ? (
                                <Input
                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                    type="number"
                                    step="any"
                                    value={editValues.price ?? tx.price ?? ''}
                                    onChange={e => updateEditValues({ price: parseFloat(e.target.value) || 0 })}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                        else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'price', editValuesRef.current.price); }
                                    }}
                                    onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'price', editValuesRef.current.price)}
                                    className="w-[60px] px-1 text-[8px]"
                                />
                            ) : (
                                <span className="text-[8px]">
                                    {tx.price ? <ValueDisplay value={tx.price} /> : '-'}
                                </span>
                            )}
                            {isEditingCell(tx.id, 'price_quote_asset_id') ? (
                                <div className="flex min-w-[70px] flex-col gap-1">
                                    <AssetSelector
                                        value={editValues.price_quote_asset_id ?? null}
                                        onChange={(assetId) => {
                                            if (!escapePressedRef.current) {
                                                updateEditValues({ price_quote_asset_id: assetId ?? undefined });
                                                saveAndClose();
                                            }
                                        }}
                                        assets={assets}
                                        onAssetCreated={refetchAssets}
                                        defaultSymbol={tx.source_price_quote_asset_symbol || ''}
                                        placeholder="Quote..."
                                        rawAssetSource={tx.source}
                                        rawAssetSymbol={tx.source_price_quote_asset_symbol}
                                    />
                                    {/* Show asset suggestions when editing unlinked price quote asset */}
                                    {tx.source_price_quote_asset_symbol && !tx.price_quote_asset_id && (() => {
                                        const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 3);
                                        return suggestions.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                updateEditValues({ price_quote_asset_id: s.item.asset_id });
                                                                saveAndClose();
                                                            }}
                                                        >
                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                            ) : tx.linked_price_quote_asset_symbol ? (
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={10}
                                    onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}
                                />
                            ) : tx.source_price_quote_asset_symbol ? (
                                <div className="flex flex-col items-start gap-0.5">
                                    <div className="flex items-center gap-0.5">
                                        <span className="cursor-pointer text-[8px] font-bold text-orange-500" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}>⚠ {tx.source_price_quote_asset_symbol}</span>
                                        <Tooltip content="Create new asset" openDelay={100}>
                                            <button
                                                type="button"
                                                onClick={(e: React.MouseEvent) => {
                                                    e.stopPropagation();
                                                    setQuickCreateAsset({
                                                        txId: tx.id,
                                                        field: 'price_quote_asset_id',
                                                        prefill: { symbol: tx.source_price_quote_asset_symbol || '' },
                                                        rawSource: tx.source,
                                                        rawSymbol: tx.source_price_quote_asset_symbol || undefined,
                                                    });
                                                }}
                                                className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                            >
                                                <FiPlusCircle size={9} />
                                            </button>
                                        </Tooltip>
                                    </div>
                                    {/* Always-visible suggestion badges for unlinked price quote asset */}
                                    {(() => {
                                        const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 2);
                                        return suggestions.length > 0 ? (
                                            <div className="flex flex-wrap gap-0.5">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                try {
                                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                        method: 'PATCH',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ price_quote_asset_id: s.item.asset_id })
                                                                    });
                                                                    if (!response.ok) throw new Error('Failed to update');
                                                                    // Also link the raw_asset
                                                                    if (tx.source_price_quote_asset_symbol) {
                                                                        try {
                                                                            await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_price_quote_asset_symbol)}`, {
                                                                                method: 'PATCH',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                            });
                                                                        } catch { }
                                                                    }
                                                                    invalidateTransactionData();
                                                                } catch (err) {
                                                                    toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                }
                                                            }}
                                                        >
                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                            ) : null}
                        </div>
                    </td>
                )}
                {showColumn('total') && (
                    <td className="py-1">
                        <span className="text-[8px]">
                            {tx.total ? <ValueDisplay value={tx.total} /> : '-'}
                        </span>
                    </td>
                )}
                {/* Fee - click to edit value, click badge to edit quote asset */}
                {showColumn('fee') && (
                    <td className="cursor-pointer py-1" onClick={() => !isEditingCell(tx.id, 'fee') && !isEditingCell(tx.id, 'fee_quote_asset_id') && startCellEdit(tx, 'fee')}>
                        <div className="flex flex-col gap-0">
                            {isEditingCell(tx.id, 'fee') ? (
                                <Input
                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                    type="number"
                                    step="any"
                                    value={editValues.fee ?? tx.fee ?? ''}
                                    onChange={e => updateEditValues({ fee: parseFloat(e.target.value) || 0 })}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                        else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee); }
                                    }}
                                    onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee)}
                                    className="w-[60px] px-1 text-[8px]"
                                />
                            ) : (
                                <span className="text-[8px]">
                                    {tx.fee ? <ValueDisplay value={tx.fee} /> : '-'}
                                </span>
                            )}
                            {isEditingCell(tx.id, 'fee_quote_asset_id') ? (
                                <div className="flex min-w-[70px] flex-col gap-1">
                                    <AssetSelector
                                        value={editValues.fee_quote_asset_id ?? null}
                                        onChange={(assetId) => {
                                            if (!escapePressedRef.current) {
                                                updateEditValues({ fee_quote_asset_id: assetId ?? undefined });
                                                saveAndClose();
                                            }
                                        }}
                                        assets={assets}
                                        onAssetCreated={refetchAssets}
                                        defaultSymbol={tx.source_fee_quote_asset_symbol || ''}
                                        placeholder="Fee..."
                                        rawAssetSource={tx.source}
                                        rawAssetSymbol={tx.source_fee_quote_asset_symbol}
                                    />
                                    {/* Show asset suggestions when editing unlinked fee quote asset */}
                                    {tx.source_fee_quote_asset_symbol && !tx.fee_quote_asset_id && (() => {
                                        const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 3);
                                        return suggestions.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                updateEditValues({ fee_quote_asset_id: s.item.asset_id });
                                                                saveAndClose();
                                                            }}
                                                        >
                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                            ) : tx.linked_fee_quote_asset_symbol ? (
                                <AssetBadge
                                    asset={tx.fee_quote_asset}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={10}
                                    onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}
                                />
                            ) : tx.source_fee_quote_asset_symbol ? (
                                <div className="flex flex-col items-start gap-0.5">
                                    <div className="flex items-center gap-0.5">
                                        <span className="cursor-pointer text-[8px] font-bold text-orange-500" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}>⚠ {tx.source_fee_quote_asset_symbol}</span>
                                        <Tooltip content="Create new asset" openDelay={100}>
                                            <button
                                                type="button"
                                                onClick={(e: React.MouseEvent) => {
                                                    e.stopPropagation();
                                                    setQuickCreateAsset({
                                                        txId: tx.id,
                                                        field: 'fee_quote_asset_id',
                                                        prefill: { symbol: tx.source_fee_quote_asset_symbol || '' },
                                                        rawSource: tx.source,
                                                        rawSymbol: tx.source_fee_quote_asset_symbol || undefined,
                                                    });
                                                }}
                                                className="flex shrink-0 cursor-pointer items-center text-green-500 hover:text-green-700"
                                            >
                                                <FiPlusCircle size={9} />
                                            </button>
                                        </Tooltip>
                                    </div>
                                    {/* Always-visible suggestion badges for unlinked fee quote asset */}
                                    {(() => {
                                        const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 2);
                                        return suggestions.length > 0 ? (
                                            <div className="flex flex-wrap gap-0.5">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className={cn('cursor-pointer text-[6px]', s.confidence < 0.9 && 'border border-slate-300 bg-white')}
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                try {
                                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                        method: 'PATCH',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ fee_quote_asset_id: s.item.asset_id })
                                                                    });
                                                                    if (!response.ok) throw new Error('Failed to update');
                                                                    // Also link the raw_asset
                                                                    if (tx.source_fee_quote_asset_symbol) {
                                                                        try {
                                                                            await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_fee_quote_asset_symbol)}`, {
                                                                                method: 'PATCH',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                            });
                                                                        } catch { }
                                                                    }
                                                                    invalidateTransactionData();
                                                                } catch (err) {
                                                                    toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                }
                                                            }}
                                                        >
                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                            ) : null}
                        </div>
                    </td>
                )}
                {/* Taxable - always toggle, saves immediately */}
                {showColumn('taxability') && (
                    <td className="py-1">
                        {(() => {
                            const status = tx.taxability_status ?? 'unknown';
                            const colorMap: Record<string, BadgeColorScheme> = {
                                taxable: 'red',
                                non_taxable: 'green',
                                unknown: 'gray',
                            };
                            const labelMap: Record<string, string> = {
                                taxable: 'Taxable',
                                non_taxable: 'Non-Taxable',
                                unknown: '?',
                            };
                            const iconMap: Record<string, React.ReactNode> = {
                                taxable: <LuCheck size={12} />,
                                non_taxable: <LuShieldOff size={12} />,
                                unknown: <LuCircleHelp size={12} />,
                            };
                            const nextMap: Record<string, string> = {
                                unknown: 'taxable',
                                taxable: 'non_taxable',
                                non_taxable: 'unknown',
                            };
                            return (
                                <div className="flex items-center gap-1">
                                    <Tooltip content={labelMap[status] || status} openDelay={200}>
                                        <Badge
                                            colorScheme={colorMap[status] || 'gray'}
                                            className="cursor-pointer"
                                            onClick={async () => {
                                                const next = nextMap[status] || 'unknown';
                                                try {
                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ taxability_status: next }),
                                                    });
                                                    if (!response.ok) throw new Error('Failed to update');
                                                    invalidateTransactionData();
                                                } catch { }
                                            }}
                                        >
                                            {iconMap[status] || status}
                                        </Badge>
                                    </Tooltip>
                                    {tx.has_fr_tax_override && (
                                        <Tooltip content="FR Tax override active" openDelay={200}>
                                            <Badge colorScheme="blue" className="text-[7px]">
                                                FR
                                            </Badge>
                                        </Tooltip>
                                    )}
                                </div>
                            );
                        })()}
                    </td>
                )}
                {/* Include Fee - always toggle, saves immediately */}
                {showColumn('feeInBase') && (
                    <td className="py-1">
                        <button
                            type="button"
                            role="switch"
                            aria-checked={tx.include_fee ?? false}
                            aria-label="Include fee in base"
                            onClick={() => quickToggle(tx, 'include_fee')}
                            className={`relative inline-flex h-[14px] w-[26px] items-center transition-colors ${tx.include_fee ? 'bg-blue-500' : 'bg-slate-300'}`}
                        >
                            <span
                                className={`inline-block h-[10px] w-[10px] transform bg-white transition-transform ${tx.include_fee ? 'translate-x-[14px]' : 'translate-x-[2px]'}`}
                            />
                        </button>
                    </td>
                )}
                {/* Bundle - read only */}
                {showColumn('bundle') && (
                    <td className="py-1">
                        {tx.user_calculation_unit_id ? <Badge colorScheme="purple">📦 #{tx.user_calculation_unit_id}</Badge> : <span className="text-[8px] text-slate-400">-</span>}
                    </td>
                )}
                {/* Tags - display only */}
                {showColumn('tags') && (
                    <td className="py-1">
                        {tx.tags && Object.keys(tx.tags).length > 0 ? (
                            <Tooltip
                                content={
                                    <div className="flex flex-col items-start gap-0.5">
                                        {Object.entries(tx.tags).map(([key, value]) => (
                                            <span key={key} className="text-xs">
                                                {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            </span>
                                        ))}
                                    </div>
                                }
                                openDelay={200}
                            >
                                <div className="flex max-w-[100px] flex-wrap gap-0.5">
                                    {Object.entries(tx.tags).slice(0, 2).map(([key, value]) => (
                                        <Badge key={key} colorScheme="blue">
                                            {key === 'value' ? String(value).slice(0, 8) : key.slice(0, 6)}
                                        </Badge>
                                    ))}
                                    {Object.keys(tx.tags).length > 2 && (
                                        <span className="text-[7px] text-slate-500">+{Object.keys(tx.tags).length - 2}</span>
                                    )}
                                </div>
                            </Tooltip>
                        ) : (
                            <span className="text-[8px] text-slate-400">-</span>
                        )}
                    </td>
                )}
                {/* Source Transaction ID - display only */}
                {showColumn('sourceTransactionId') && (
                    <td className="py-1">
                        {tx.source_transaction_id ? (
                            <Tooltip content={tx.source_transaction_id} openDelay={200}>
                                <span className="cursor-pointer text-[8px] text-slate-600">
                                    {tx.source_transaction_id.slice(0, 12)}{tx.source_transaction_id.length > 12 && '…'}
                                </span>
                            </Tooltip>
                        ) : (
                            <span className="text-[8px] text-slate-400">-</span>
                        )}
                    </td>
                )}
                {/* Additional plugin columns */}
                {additionalColumns.map(col => (
                    <td key={col.id} className="py-1" style={col.cellBg ? { backgroundColor: col.cellBg } : undefined}>
                        {col.render(tx as Transaction)}
                    </td>
                ))}
                {/* Status - click to edit */}
                {showColumn('status') && (!embeddedMode || showSelectionInEmbedded) && (
                    <td className="sticky right-[50px] z-[5] border-l-2 border-slate-300 px-1 py-0 cursor-pointer" style={{ backgroundColor: rowBgColor }} onClick={() => !isEditingCell(tx.id, 'review_status') && startCellEdit(tx, 'review_status')}>
                        {isEditingCell(tx.id, 'review_status') ? (
                            <select
                                title="Review status"
                                className="w-[55px] border border-slate-300"
                                value={editValues.review_status || tx.review_status}
                                onChange={e => updateEditValues({ review_status: e.target.value as TransactionStatus })}
                                onKeyDown={handleEditKeyDown}
                                onBlur={saveAndClose}
                                style={{ fontSize: '7px', padding: '1px' }}
                            >
                                <option value="valid">Valid</option>
                                <option value="pending">Pending</option>
                                <option value="invalid">Invalid</option>
                            </select>
                        ) : (
                            <div className="flex flex-col gap-0">
                                <Badge colorScheme={statusBadgeColors[tx.review_status] || 'gray'} className="text-[6px]">
                                    {tx.review_status}
                                </Badge>
                                {/* Quick set valid button */}
                                {tx.review_status !== 'valid' && (
                                    <button
                                        type="button"
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            try {
                                                const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                    method: 'PATCH',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ review_status: 'valid' }),
                                                });
                                                if (!response.ok) throw new Error('Failed to update');
                                                invalidateTransactionData();
                                            } catch (err) {
                                                toaster.error({ title: 'Error', description: 'Failed to set status' });
                                            }
                                        }}
                                        title="Set valid"
                                        className="flex h-3 min-w-[14px] cursor-pointer items-center justify-center p-0 text-green-500 hover:text-green-700"
                                    >
                                        <LuCheck size={8} />
                                    </button>
                                )}
                                {/* Duplicate indicators */}
                                {hasPotentialDuplicateTag(tx) && (() => {
                                    const resolutionTag = getDuplicateResolutionTag(tx);
                                    const groupHash = getDuplicateGroupHash(tx);

                                    if (resolutionTag) {
                                        // Read dup_resolution field from new format
                                        const resolution = resolutionTag.dup_resolution;
                                        const status = resolutionTag.data?.status;

                                        if (resolution === 'kept' || resolution === 'keep_selected') {
                                            return (
                                                <Tooltip content={`Kept (${status || 'resolved'})`}>
                                                    <Badge colorScheme="green" className="border border-slate-300 bg-white text-[7px]">
                                                        <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                        Kept
                                                    </Badge>
                                                </Tooltip>
                                            );
                                        } else if (resolution === 'dismissed' || resolution === 'dismiss_selected') {
                                            return (
                                                <Tooltip content={`Dismissed (${status || 'resolved'})`}>
                                                    <Badge colorScheme="gray" className="border border-slate-300 bg-white text-[7px]">
                                                        <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                        Dismissed
                                                    </Badge>
                                                </Tooltip>
                                            );
                                        } else if (resolution === 'merged') {
                                            return (
                                                <Tooltip content={`Merged (${status || 'resolved'})`}>
                                                    <Badge colorScheme="purple" className="border border-slate-300 bg-white text-[7px]">
                                                        <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                        Merged
                                                    </Badge>
                                                </Tooltip>
                                            );
                                        }
                                    }

                                    // Show pending duplicate indicator
                                    return (
                                        <Tooltip content={`Potential duplicate (group: ${groupHash?.slice(0, 8)}...)`}>
                                            <Badge colorScheme="orange" className="text-[7px]">
                                                <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                Duplicate?
                                            </Badge>
                                        </Tooltip>
                                    );
                                })()}
                            </div>
                        )}
                    </td>
                )}
                {/* Actions - show cancel when editing */}
                {!embeddedMode && (
                    <td className="sticky right-0 z-[5] min-w-[50px] px-0 py-0" style={{ backgroundColor: rowBgColor }}>
                        <div className="flex gap-0">
                            {/* Unbundle action — remove tx from bundle */}
                            {!suggestionEntry && tx.user_calculation_unit_id && (
                                <button
                                    type="button"
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                            const response = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}/remove-transactions`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ transaction_ids: [tx.id] }),
                                            });
                                            if (!response.ok) throw new Error('Failed to unbundle');
                                            invalidateTransactionData();
                                            invalidateBundleQueries();
                                            toaster.success({ title: 'Unbundled', description: `Transaction #${tx.id} removed from bundle` });
                                        } catch (err) {
                                            toaster.error({ title: 'Error', description: 'Failed to remove from bundle' });
                                        }
                                    }}
                                    onMouseEnter={() => setHoveredBundleId(tx.user_calculation_unit_id!)}
                                    onMouseLeave={() => setHoveredBundleId(null)}
                                    title={`Remove from bundle #${tx.user_calculation_unit_id}`}
                                    className="flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0 text-red-500 hover:text-red-700"
                                >
                                    <LuPackageX size={10} />
                                </button>
                            )}
                            {/* Bundle suggestion icon in actions */}
                            {suggestionEntry && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenSuggestionTxId(openSuggestionTxId === tx.id ? null : tx.id);
                                    }}
                                    onMouseEnter={() => setHoveredSuggestionGroup(suggestionEntry.groupIndex)}
                                    onMouseLeave={() => setHoveredSuggestionGroup(null)}
                                    title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                    className="flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0"
                                >
                                    <BundleSuggestionIcon size={10} color={suggestionEntry.color} />
                                </button>
                            )}
                            {getEditingTxId() === tx.id ? (
                                <button type="button" onClick={cancelEdit} title="Cancel (Esc)" className="flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0 text-slate-500 hover:text-slate-700">
                                    ✗
                                </button>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setDrawerTransactionId(tx.id);
                                            setIsDrawerOpen(true);
                                        }}
                                        title="Edit all fields"
                                        className="flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0 text-blue-500 hover:text-blue-700"
                                    >
                                        <LuPencil size={10} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setTransactionToDelete(tx);
                                            fetchDeletionImpact([tx.id]);
                                            setShowDeleteDialog(true);
                                        }}
                                        title="Delete transaction"
                                        className="flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0 text-red-500 hover:text-red-700"
                                    >
                                        🗑️
                                    </button>
                                </>
                            )}
                            {/* Additional plugin row actions */}
                            {additionalRowActions.map(action => {
                                const isVisible = action.isVisible ? action.isVisible(tx as Transaction) : true;
                                const isDisabled = action.isDisabled ? action.isDisabled(tx as Transaction) : false;
                                if (!isVisible) return null;
                                return (
                                    <button
                                        key={action.id}
                                        type="button"
                                        onClick={() => action.onClick(tx as Transaction)}
                                        disabled={isDisabled}
                                        title={action.label}
                                        className={cn(
                                            'flex h-4 min-w-[16px] cursor-pointer items-center justify-center p-0 disabled:cursor-not-allowed disabled:opacity-50',
                                            PLUGIN_ACTION_COLORS[action.colorPalette || 'gray'] || PLUGIN_ACTION_COLORS.gray
                                        )}
                                    >
                                        {action.icon}
                                    </button>
                                );
                            })}
                        </div>
                    </td>
                )}
            </tr>
        </React.Fragment>
    );

}, arePropsEqual);
