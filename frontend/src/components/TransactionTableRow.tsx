/**
 * TransactionTableRow — Memoized row component for the transactions table.
 *
 * Extracted from TransactionsTable to enable React.memo optimization.
 * When a single cell is edited/hovered, only the affected row re-renders
 * instead of all 50+ rows recreating ~70 inline closures each.
 */

import React from 'react';
import {
    Badge, Box, Button, Checkbox, Flex, HStack, Input,
    NativeSelect, Switch, Table, Text, VStack
} from '@chakra-ui/react';
import { BiTransfer } from 'react-icons/bi';
import { RiExchangeFundsLine } from 'react-icons/ri';
import { FaQuestion } from 'react-icons/fa';
import { LuPencil, LuPackageX, LuCheck, LuPlus, LuMinus, LuX } from 'react-icons/lu';
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

// Direction color mapping
const directionRowColors: Record<string, string> = {
    [Direction.INFLOW]: 'green.50',
    [Direction.OUTFLOW]: 'red.50',
    internal: 'gray.50',
};

const statusBadgeColors: Record<TransactionStatus, string> = {
    [ReviewStatus.VALID]: 'green',
    [ReviewStatus.PENDING]: 'yellow',
    [ReviewStatus.INVALID]: 'red',
};

// ========== Editable field types (shared with TransactionsTable) ==========
export type EditableField =
    | 'account_id' | 'from_account_id' | 'to_account_id'
    | 'source_transaction_type' | 'direction' | 'transaction_type'
    | 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id'
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
            <Table.Row
                key={tx.id}
                bg="gray.200"
                _hover={{ bg: 'gray.300' }}
                cursor="pointer"
                onClick={() => toggleInvalidRow(tx.id)}
                height="20px"
            >
                <Table.Cell
                    colSpan={visibleColumnCount}
                    py={0}
                    px={0}
                    position="relative"
                >
                    {/* Red status band on far left */}
                    <Box
                        position="absolute"
                        left={0}
                        top={0}
                        bottom={0}
                        width="4px"
                        bg="red.500"
                    />
                    <Flex align="center" gap={2} pl="10px" pr={2} minH="20px">
                        <Box
                            as="button"
                            display="flex"
                            alignItems="center"
                            color="gray.400"
                            _hover={{ color: 'red.500' }}
                            onClick={(e: React.MouseEvent) => {
                                e.stopPropagation();
                                toggleInvalidRow(tx.id);
                            }}
                            title="Expand invalid row"
                            flexShrink={0}
                        >
                            <LuPlus size={11} />
                        </Box>
                        <Badge colorPalette="red" variant="subtle" size="xs" fontSize="7px" px={1}>
                            <LuX size={8} /> Invalid
                        </Badge>
                        <Text fontSize="7px" color="gray.400" truncate maxW="200px">
                            {formatDateTimeCompact(tx.date_time)} · {tx.source_asset_symbol || tx.linked_asset?.symbol || '—'}
                            {tx.source ? ` · ${tx.source}` : ''}
                        </Text>
                    </Flex>
                </Table.Cell>
            </Table.Row>
        );
    }

    // ============== Normal / Expanded Row ==============
    return (
        <React.Fragment key={tx.id}>
            <Table.Row
                bg={rowBgColor}
                _hover={{ bg: 'blue.50' }}
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
                <Table.Cell position="sticky" left={0} bg={rowBgColor} zIndex={5} borderRight="2px solid" borderColor="gray.300" p={0}>
                    {/* Review status band — full cell height */}
                    <Box
                        position="absolute"
                        left={0}
                        top={0}
                        bottom={0}
                        width="4px"
                        bg={rowBorderColor}
                    />
                    {/* Suggestion / Bundle color band — right next to review status (mutually exclusive) */}
                    {suggestionEntry ? (
                        <Box
                            position="absolute"
                            left="5px"
                            top={0}
                            bottom={0}
                            width="4px"
                            bg={suggestionEntry.color}
                            borderRadius="2px"
                            zIndex={1}
                        />
                    ) : (tx.user_calculation_unit_id != null) ? (
                        <Box
                            position="absolute"
                            left="5px"
                            top={0}
                            bottom={0}
                            width="4px"
                            bg={bundleColorMap.get(tx.user_calculation_unit_id) || 'purple.400'}
                            borderRadius="2px"
                            zIndex={1}
                        />
                    ) : null}
                    {/* Duplicate band (Band 3) — right of suggestion/bundle band */}
                    {duplicateEntry && (
                        <Box
                            position="absolute"
                            left="10px"
                            top={0}
                            bottom={0}
                            width="4px"
                            bg={duplicateEntry.color}
                            borderRadius="2px"
                            zIndex={1}
                        />
                    )}
                    <Flex gap={1} align="center" pl={duplicateEntry ? '17px' : (suggestionEntry || tx.user_calculation_unit_id) ? '12px' : '7px'} pr={1} minH="28px">
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
                                <Box
                                    as="button"
                                    display="flex"
                                    alignItems="center"
                                    p={0}
                                    cursor="pointer"
                                    color={duplicateEntry.color}
                                    _hover={{ opacity: 0.7 }}
                                    title={`Duplicate suspicion: ${duplicateEntry.matchCriteria}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    <DuplicateIcon size={11} />
                                </Box>
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
                                <Box
                                    as="button"
                                    display="flex"
                                    alignItems="center"
                                    p={0}
                                    cursor="pointer"
                                    color={suggestionEntry.color}
                                    _hover={{ opacity: 0.7 }}
                                    title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    <BundleSuggestionIcon size={12} />
                                </Box>
                            </SuggestionPopover>
                        )}
                        {/* Bundle membership badge — clickable, opens popover */}
                        {!suggestionEntry && tx.user_calculation_unit_id && (
                            <BundleMembershipPopover
                                bundleId={tx.user_calculation_unit_id}
                                color={bundleColorMap.get(tx.user_calculation_unit_id) || 'purple.400'}
                                open={openBundleTxId === tx.id}
                                onOpenChange={(open) => setOpenBundleTxId(open ? tx.id : null)}
                                onTransactionClick={(txId) => {
                                    setDrawerTransactionId(txId);
                                    setIsDrawerOpen(true);
                                }}
                            >
                                <Badge
                                    as="button"
                                    size="xs"
                                    fontSize="7px"
                                    colorPalette="purple"
                                    variant="subtle"
                                    cursor="pointer"
                                    _hover={{ opacity: 0.7 }}
                                    title={`Bundle #${tx.user_calculation_unit_id}`}
                                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                >
                                    📦 #{tx.user_calculation_unit_id}
                                </Badge>
                            </BundleMembershipPopover>
                        )}
                        {/* Collapse toggle for expanded invalid rows */}
                        {tx.review_status === 'invalid' && expandedInvalidIds.has(tx.id) && (
                            <Box
                                as="button"
                                display="flex"
                                alignItems="center"
                                color="red.400"
                                _hover={{ color: 'red.600' }}
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    toggleInvalidRow(tx.id);
                                }}
                                title="Collapse invalid row"
                                p={0}
                                flexShrink={0}
                            >
                                <LuMinus size={11} />
                            </Box>
                        )}
                        {(!embeddedMode || showSelectionInEmbedded) && (
                            <Checkbox.Root
                                checked={selectedIds.has(tx.id)}
                                onCheckedChange={() => toggleSelection(tx.id)}
                            >
                                <Checkbox.HiddenInput />
                                <Checkbox.Control />
                            </Checkbox.Root>
                        )}
                        {/* TX ID - clickable to open drawer */}
                        <Text
                            fontSize="8px"
                            fontFamily="mono"
                            color="gray.400"
                            cursor="pointer"
                            _hover={{ color: 'blue.500', textDecoration: 'underline' }}
                            onClick={() => {
                                setDrawerTransactionId(tx.id);
                                setIsDrawerOpen(true);
                            }}
                            title={`TX #${tx.id} — Click to view details`}
                        >
                            #{tx.id}
                        </Text>
                    </Flex>
                </Table.Cell>
                {showColumn('id') && (
                    <Table.Cell py={1}>
                        <Text fontSize="8px" fontFamily="mono" color="gray.500">{tx.id}</Text>
                    </Table.Cell>
                )}
                {/* Date/Time - click to edit */}
                {showColumn('date') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'date_time') && startCellEdit(tx, 'date_time')} cursor="pointer">
                        {isEditingCell(tx.id, 'date_time') ? (
                            <Input
                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                size="xs"
                                type="datetime-local"
                                value={toDateTimeLocalString(editValues.date_time)}
                                onChange={e => updateEditValues({ date_time: e.target.value })}
                                onKeyDown={handleEditKeyDown}
                                onBlur={saveAndClose}
                                width="130px"
                                fontSize="8px"
                                px={1}
                            />
                        ) : (
                            <Text fontSize="8px">{formatDateTimeCompact(tx.date_time)}</Text>
                        )}
                    </Table.Cell>
                )}
                {/* Source Info - merged column with Source Account, Source, Source Type, Source Symbol */}
                {showColumn('source') && (
                    <Table.Cell py={1} cursor="pointer">
                        {isEditingCell(tx.id, 'account_id') ? (
                            <Flex direction="column" gap={1} minW="120px">
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
                                <Text fontSize="7px" color="gray.400">
                                    {[tx.source, tx.source_transaction_type].filter(Boolean).join(' · ')}
                                </Text>
                            </Flex>
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
                    </Table.Cell>
                )}
                {/* From / To Accounts - merged column showing both in 2 lines with inline editing */}
                {showColumn('accounts') && (
                    <Table.Cell py={1}>
                        <VStack gap={0.5} align="center">
                            {/* From Account - editable */}
                            {isEditingCell(tx.id, 'from_account_id') ? (
                                <Flex direction="column" gap={1} minW="100px">
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
                                </Flex>
                            ) : (tx.from_account_id || tx.source_from_account) ? (
                                <Flex direction="column" gap={0.5} align="start">
                                    <Flex align="center" gap={0.5}>
                                        <Tooltip
                                            content={
                                                tx.from_account_id
                                                    ? `From: ${tx.from_account_name || 'Account'}${tx.source_from_account ? ` — Source: ${tx.source_from_account}` : ''} — Click to edit`
                                                    : `From: ${tx.source_from_account} - Click to link`
                                            }
                                            openDelay={200}
                                        >
                                            <Badge
                                                size="xs"
                                                colorPalette={tx.from_account_id ? 'cyan' : 'orange'}
                                                variant="subtle"
                                                cursor="pointer"
                                                onClick={() => startCellEdit(tx, 'from_account_id')}
                                            >
                                                {tx.from_account_id ? (
                                                    (tx.from_account_name || `#${tx.from_account_id}`).slice(0, 10)
                                                ) : (
                                                    <>⚠ {(tx.source_from_account || '').slice(0, 8)}{(tx.source_from_account || '').length > 8 && '…'}</>
                                                )}
                                            </Badge>
                                        </Tooltip>
                                        {!tx.from_account_id && tx.source_from_account && (
                                            <Tooltip content="Create new account" openDelay={100}>
                                                <Box
                                                    as="button"
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
                                                    color="green.500"
                                                    cursor="pointer"
                                                    flexShrink={0}
                                                    _hover={{ color: 'green.700' }}
                                                >
                                                    <FiPlusCircle size={10} />
                                                </Box>
                                            </Tooltip>
                                        )}
                                    </Flex>
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
                                </Flex>
                            ) : (
                                <Badge
                                    size="xs"
                                    colorPalette="gray"
                                    variant="outline"
                                    cursor="pointer"
                                    onClick={() => startCellEdit(tx, 'from_account_id')}
                                >
                                    + From
                                </Badge>
                            )}
                            {/* Arrow separator between from and to */}
                            <Text fontSize="10px" color="gray.400" lineHeight="1">↓</Text>
                            {/* To Account - editable */}
                            {isEditingCell(tx.id, 'to_account_id') ? (
                                <Flex direction="column" gap={1} minW="100px">
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
                                </Flex>
                            ) : (tx.to_account_id || tx.source_to_account) ? (
                                <Flex direction="column" gap={0.5} align="start">
                                    <Flex align="center" gap={0.5}>
                                        <Tooltip
                                            content={
                                                tx.to_account_id
                                                    ? `To: ${tx.to_account_name || 'Account'}${tx.source_to_account ? ` — Source: ${tx.source_to_account}` : ''} — Click to edit`
                                                    : `To: ${tx.source_to_account} - Click to link`
                                            }
                                            openDelay={200}
                                        >
                                            <Badge
                                                size="xs"
                                                colorPalette={tx.to_account_id ? 'cyan' : 'orange'}
                                                variant="subtle"
                                                cursor="pointer"
                                                onClick={() => startCellEdit(tx, 'to_account_id')}
                                            >
                                                {tx.to_account_id ? (
                                                    (tx.to_account_name || `#${tx.to_account_id}`).slice(0, 10)
                                                ) : (
                                                    <>⚠ {(tx.source_to_account || '').slice(0, 8)}{(tx.source_to_account || '').length > 8 && '…'}</>
                                                )}
                                            </Badge>
                                        </Tooltip>
                                        {!tx.to_account_id && tx.source_to_account && (
                                            <Tooltip content="Create new account" openDelay={100}>
                                                <Box
                                                    as="button"
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
                                                    color="green.500"
                                                    cursor="pointer"
                                                    flexShrink={0}
                                                    _hover={{ color: 'green.700' }}
                                                >
                                                    <FiPlusCircle size={10} />
                                                </Box>
                                            </Tooltip>
                                        )}
                                    </Flex>
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
                                </Flex>
                            ) : (
                                <Badge
                                    size="xs"
                                    colorPalette="gray"
                                    variant="outline"
                                    cursor="pointer"
                                    onClick={() => startCellEdit(tx, 'to_account_id')}
                                >
                                    + To
                                </Badge>
                            )}
                        </VStack>
                    </Table.Cell>
                )}
                {/* Direction - click to edit */}
                {showColumn('direction') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'direction') && startCellEdit(tx, 'direction')} cursor="pointer">
                        {isEditingCell(tx.id, 'direction') ? (
                            <NativeSelect.Root size="sm" width="45px">
                                <NativeSelect.Field
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
                                </NativeSelect.Field>
                            </NativeSelect.Root>
                        ) : (
                            <Badge size="sm" colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}>
                                {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                            </Badge>
                        )}
                    </Table.Cell>
                )}
                {/* Type - click to edit */}
                {showColumn('type') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'transaction_type') && startCellEdit(tx, 'transaction_type')} cursor="pointer">
                        {isEditingCell(tx.id, 'transaction_type') ? (
                            <NativeSelect.Root size="sm" width="80px">
                                <NativeSelect.Field
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
                                </NativeSelect.Field>
                            </NativeSelect.Root>
                        ) : (
                            <Flex align="center" gap={1}>
                                {tx.transaction_type === 'transfer' ? (
                                    <BiTransfer color="#805AD5" size={12} title="Transfer" />
                                ) : tx.transaction_type === 'trade' ? (
                                    <RiExchangeFundsLine color="#3182CE" size={12} title="Trade" />
                                ) : tx.transaction_type === 'technical' ? (
                                    <FaQuestion color="#A0AEC0" size={10} title="Technical (approval, contract call)" />
                                ) : (
                                    <FaQuestion color="#718096" size={10} title="Other" />
                                )}
                                <Badge size="xs" colorPalette="blue">{tx.transaction_type?.substring(0, 6)}</Badge>
                            </Flex>
                        )}
                    </Table.Cell>
                )}
                {/* Linked Asset - click to edit */}
                {showColumn('asset') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'asset_id') && startCellEdit(tx, 'asset_id')} cursor="pointer">
                        {isEditingCell(tx.id, 'asset_id') ? (
                            <Flex direction="column" gap={1} minW="90px">
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
                                        <HStack gap={1} flexWrap="wrap">
                                            <Text fontSize="7px" color="gray.500">Suggestions:</Text>
                                            {suggestions.map((s, idx) => (
                                                <Tooltip
                                                    key={idx}
                                                    content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                    openDelay={100}
                                                >
                                                    <Badge
                                                        size="xs"
                                                        colorPalette={getConfidenceColor(s.confidence)}
                                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                        cursor="pointer"
                                                        fontSize="7px"
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
                                        </HStack>
                                    ) : null;
                                })()}
                            </Flex>
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
                                <Flex direction="column" gap={0.5} align="start">
                                    <Flex align="center" gap={0.5}>
                                        <Tooltip content={`${tx.source_asset_symbol} - Click to link`} openDelay={200}>
                                            <Text color="orange.500" fontWeight="bold" fontSize="8px" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}>
                                                ⚠ {tx.source_asset_symbol.slice(0, 8)}{tx.source_asset_symbol.length > 8 && '…'}
                                            </Text>
                                        </Tooltip>
                                        <Tooltip content="Create new asset" openDelay={100}>
                                            <Box
                                                as="button"
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
                                                color="green.500"
                                                cursor="pointer"
                                                flexShrink={0}
                                                _hover={{ color: 'green.700' }}
                                            >
                                                <FiPlusCircle size={10} />
                                            </Box>
                                        </Tooltip>
                                    </Flex>
                                    {/* Always-visible suggestion badges for unlinked asset */}
                                    {(() => {
                                        const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 2);
                                        return suggestions.length > 0 ? (
                                            <HStack gap={0.5} flexWrap="wrap">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            fontSize="6px"
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
                                            </HStack>
                                        ) : null;
                                    })()}
                                </Flex>
                            ) : (
                                <Text color="gray.400" fontSize="8px">-</Text>
                            )
                        )}
                    </Table.Cell>
                )}
                {/* Quantity - click to edit */}
                {showColumn('qty') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'quantity') && startCellEdit(tx, 'quantity')} cursor="pointer">
                        {isEditingCell(tx.id, 'quantity') ? (
                            <Input
                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                size="xs"
                                type="number"
                                step="any"
                                value={editValues.quantity ?? tx.quantity ?? ''}
                                onChange={e => updateEditValues({ quantity: parseFloat(e.target.value) || 0 })}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                    else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity); }
                                }}
                                onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity)}
                                width="60px"
                                fontSize="8px"
                                px={1}
                            />
                        ) : (
                            <Text fontSize="8px"><ValueDisplay value={tx.quantity} /></Text>
                        )}
                    </Table.Cell>
                )}
                {/* Price - click to edit value, click badge to edit quote asset */}
                {showColumn('price') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'price') && !isEditingCell(tx.id, 'price_quote_asset_id') && startCellEdit(tx, 'price')} cursor="pointer">
                        <Flex direction="column" gap={0}>
                            {isEditingCell(tx.id, 'price') ? (
                                <Input
                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                    size="xs"
                                    type="number"
                                    step="any"
                                    value={editValues.price ?? tx.price ?? ''}
                                    onChange={e => updateEditValues({ price: parseFloat(e.target.value) || 0 })}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                        else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'price', editValuesRef.current.price); }
                                    }}
                                    onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'price', editValuesRef.current.price)}
                                    width="60px"
                                    fontSize="8px"
                                    px={1}
                                />
                            ) : (
                                <Text fontSize="8px">
                                    {tx.price ? <ValueDisplay value={tx.price} /> : '-'}
                                </Text>
                            )}
                            {isEditingCell(tx.id, 'price_quote_asset_id') ? (
                                <Flex direction="column" gap={1} minW="70px">
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
                                            <HStack gap={1} flexWrap="wrap">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            fontSize="6px"
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
                                            </HStack>
                                        ) : null;
                                    })()}
                                </Flex>
                            ) : tx.linked_price_quote_asset_symbol ? (
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={10}
                                    onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}
                                />
                            ) : tx.source_price_quote_asset_symbol ? (
                                <Flex direction="column" gap={0.5} align="start">
                                    <Flex align="center" gap={0.5}>
                                        <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}>⚠ {tx.source_price_quote_asset_symbol}</Text>
                                        <Tooltip content="Create new asset" openDelay={100}>
                                            <Box
                                                as="button"
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
                                                color="green.500"
                                                cursor="pointer"
                                                flexShrink={0}
                                                _hover={{ color: 'green.700' }}
                                            >
                                                <FiPlusCircle size={9} />
                                            </Box>
                                        </Tooltip>
                                    </Flex>
                                    {/* Always-visible suggestion badges for unlinked price quote asset */}
                                    {(() => {
                                        const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 2);
                                        return suggestions.length > 0 ? (
                                            <HStack gap={0.5} flexWrap="wrap">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            fontSize="6px"
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
                                            </HStack>
                                        ) : null;
                                    })()}
                                </Flex>
                            ) : null}
                        </Flex>
                    </Table.Cell>
                )}
                {showColumn('total') && (
                    <Table.Cell py={1}>
                        <Text fontSize="8px">
                            {tx.total ? <ValueDisplay value={tx.total} /> : '-'}
                        </Text>
                    </Table.Cell>
                )}
                {/* Fee - click to edit value, click badge to edit quote asset */}
                {showColumn('fee') && (
                    <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'fee') && !isEditingCell(tx.id, 'fee_quote_asset_id') && startCellEdit(tx, 'fee')} cursor="pointer">
                        <Flex direction="column" gap={0}>
                            {isEditingCell(tx.id, 'fee') ? (
                                <Input
                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                    size="xs"
                                    type="number"
                                    step="any"
                                    value={editValues.fee ?? tx.fee ?? ''}
                                    onChange={e => updateEditValues({ fee: parseFloat(e.target.value) || 0 })}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                        else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee); }
                                    }}
                                    onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee)}
                                    width="60px"
                                    fontSize="8px"
                                    px={1}
                                />
                            ) : (
                                <Text fontSize="8px">
                                    {tx.fee ? <ValueDisplay value={tx.fee} /> : '-'}
                                </Text>
                            )}
                            {isEditingCell(tx.id, 'fee_quote_asset_id') ? (
                                <Flex direction="column" gap={1} minW="70px">
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
                                            <HStack gap={1} flexWrap="wrap">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            fontSize="6px"
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
                                            </HStack>
                                        ) : null;
                                    })()}
                                </Flex>
                            ) : tx.linked_fee_quote_asset_symbol ? (
                                <AssetBadge
                                    asset={tx.fee_quote_asset}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={10}
                                    onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}
                                />
                            ) : tx.source_fee_quote_asset_symbol ? (
                                <Flex direction="column" gap={0.5} align="start">
                                    <Flex align="center" gap={0.5}>
                                        <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}>⚠ {tx.source_fee_quote_asset_symbol}</Text>
                                        <Tooltip content="Create new asset" openDelay={100}>
                                            <Box
                                                as="button"
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
                                                color="green.500"
                                                cursor="pointer"
                                                flexShrink={0}
                                                _hover={{ color: 'green.700' }}
                                            >
                                                <FiPlusCircle size={9} />
                                            </Box>
                                        </Tooltip>
                                    </Flex>
                                    {/* Always-visible suggestion badges for unlinked fee quote asset */}
                                    {(() => {
                                        const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 2);
                                        return suggestions.length > 0 ? (
                                            <HStack gap={0.5} flexWrap="wrap">
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            fontSize="6px"
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
                                            </HStack>
                                        ) : null;
                                    })()}
                                </Flex>
                            ) : null}
                        </Flex>
                    </Table.Cell>
                )}
                {/* Taxable - always toggle, saves immediately */}
                {showColumn('taxability') && (
                    <Table.Cell py={1}>
                        {(() => {
                            const status = tx.taxability_status ?? 'unknown';
                            const colorMap: Record<string, string> = {
                                taxable: 'red',
                                non_taxable: 'green',
                                unknown: 'gray',
                            };
                            const labelMap: Record<string, string> = {
                                taxable: 'Taxable',
                                non_taxable: 'Non-Taxable',
                                unknown: '?',
                            };
                            const nextMap: Record<string, string> = {
                                unknown: 'taxable',
                                taxable: 'non_taxable',
                                non_taxable: 'unknown',
                            };
                            return (
                                <Badge
                                    size="sm"
                                    colorPalette={colorMap[status] || 'gray'}
                                    cursor="pointer"
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
                                    {labelMap[status] || status}
                                </Badge>
                            );
                        })()}
                    </Table.Cell>
                )}
                {/* Include Fee - always toggle, saves immediately */}
                {showColumn('feeInBase') && (
                    <Table.Cell py={1}>
                        <Switch.Root
                            size="sm"
                            checked={tx.include_fee ?? false}
                            onCheckedChange={() => quickToggle(tx, 'include_fee')}
                        >
                            <Switch.HiddenInput />
                            <Switch.Control />
                        </Switch.Root>
                    </Table.Cell>
                )}
                {/* Bundle - read only */}
                {showColumn('bundle') && (
                    <Table.Cell py={1}>
                        {tx.user_calculation_unit_id ? <Badge size="sm" colorPalette="purple">📦 #{tx.user_calculation_unit_id}</Badge> : <Text fontSize="8px" color="gray.400">-</Text>}
                    </Table.Cell>
                )}
                {/* Tags - display only */}
                {showColumn('tags') && (
                    <Table.Cell py={1}>
                        {tx.tags && Object.keys(tx.tags).length > 0 ? (
                            <Tooltip
                                content={
                                    <VStack gap={0.5} align="start">
                                        {Object.entries(tx.tags).map(([key, value]) => (
                                            <Text key={key} fontSize="xs">
                                                {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            </Text>
                                        ))}
                                    </VStack>
                                }
                                openDelay={200}
                            >
                                <HStack gap={0.5} flexWrap="wrap" maxW="100px">
                                    {Object.entries(tx.tags).slice(0, 2).map(([key, value]) => (
                                        <Badge key={key} size="xs" colorPalette="blue" variant="subtle">
                                            {key === 'value' ? String(value).slice(0, 8) : key.slice(0, 6)}
                                        </Badge>
                                    ))}
                                    {Object.keys(tx.tags).length > 2 && (
                                        <Text fontSize="7px" color="gray.500">+{Object.keys(tx.tags).length - 2}</Text>
                                    )}
                                </HStack>
                            </Tooltip>
                        ) : (
                            <Text fontSize="8px" color="gray.400">-</Text>
                        )}
                    </Table.Cell>
                )}
                {/* Source Transaction ID - display only */}
                {showColumn('sourceTransactionId') && (
                    <Table.Cell py={1}>
                        {tx.source_transaction_id ? (
                            <Tooltip content={tx.source_transaction_id} openDelay={200}>
                                <Text fontSize="8px" color="gray.600" cursor="pointer">
                                    {tx.source_transaction_id.slice(0, 12)}{tx.source_transaction_id.length > 12 && '…'}
                                </Text>
                            </Tooltip>
                        ) : (
                            <Text fontSize="8px" color="gray.400">-</Text>
                        )}
                    </Table.Cell>
                )}
                {/* Additional plugin columns */}
                {additionalColumns.map(col => (
                    <Table.Cell key={col.id} py={1}>
                        {col.render(tx as Transaction)}
                    </Table.Cell>
                ))}
                {/* Status - click to edit */}
                {showColumn('status') && (!embeddedMode || showSelectionInEmbedded) && (
                    <Table.Cell position="sticky" right="50px" bg={rowBgColor} zIndex={5} borderLeft="2px solid" borderColor="gray.300" onClick={() => !isEditingCell(tx.id, 'review_status') && startCellEdit(tx, 'review_status')} cursor="pointer" px={1} py={0}>
                        {isEditingCell(tx.id, 'review_status') ? (
                            <NativeSelect.Root size="sm" width="55px">
                                <NativeSelect.Field
                                    value={editValues.review_status || tx.review_status}
                                    onChange={e => updateEditValues({ review_status: e.target.value as TransactionStatus })}
                                    onKeyDown={handleEditKeyDown}
                                    onBlur={saveAndClose}
                                    style={{ fontSize: '7px', padding: '1px' }}
                                >
                                    <option value="valid">Valid</option>
                                    <option value="pending">Pending</option>
                                    <option value="invalid">Invalid</option>
                                </NativeSelect.Field>
                            </NativeSelect.Root>
                        ) : (
                            <Flex direction="column" gap={0}>
                                <Badge size="xs" colorPalette={statusBadgeColors[tx.review_status] || 'gray'} fontSize="6px">
                                    {tx.review_status}
                                </Badge>
                                {/* Quick set valid button */}
                                {tx.review_status !== 'valid' && (
                                    <Button
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette="green"
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
                                        p={0}
                                        minW="14px"
                                        h="12px"
                                    >
                                        <LuCheck size={8} />
                                    </Button>
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
                                                    <Badge size="xs" colorPalette="green" variant="outline" fontSize="7px">
                                                        <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                        Kept
                                                    </Badge>
                                                </Tooltip>
                                            );
                                        } else if (resolution === 'dismissed' || resolution === 'dismiss_selected') {
                                            return (
                                                <Tooltip content={`Dismissed (${status || 'resolved'})`}>
                                                    <Badge size="xs" colorPalette="gray" variant="outline" fontSize="7px">
                                                        <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                        Dismissed
                                                    </Badge>
                                                </Tooltip>
                                            );
                                        } else if (resolution === 'merged') {
                                            return (
                                                <Tooltip content={`Merged (${status || 'resolved'})`}>
                                                    <Badge size="xs" colorPalette="purple" variant="outline" fontSize="7px">
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
                                            <Badge size="xs" colorPalette="orange" variant="solid" fontSize="7px">
                                                <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                Duplicate?
                                            </Badge>
                                        </Tooltip>
                                    );
                                })()}
                            </Flex>
                        )}
                    </Table.Cell>
                )}
                {/* Actions - show cancel when editing */}
                {!embeddedMode && (
                    <Table.Cell position="sticky" right={0} bg={rowBgColor} zIndex={5} minW="50px" px={0} py={0}>
                        <Flex gap={0}>
                            {/* Unbundle action — remove tx from bundle */}
                            {!suggestionEntry && tx.user_calculation_unit_id && (
                                <Button
                                    size="2xs"
                                    variant="ghost"
                                    colorPalette="red"
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
                                    p={0}
                                    minW="16px"
                                    h="16px"
                                >
                                    <LuPackageX size={10} />
                                </Button>
                            )}
                            {/* Bundle suggestion icon in actions */}
                            {suggestionEntry && (
                                <Button
                                    size="2xs"
                                    variant="ghost"
                                    colorPalette="teal"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenSuggestionTxId(openSuggestionTxId === tx.id ? null : tx.id);
                                    }}
                                    onMouseEnter={() => setHoveredSuggestionGroup(suggestionEntry.groupIndex)}
                                    onMouseLeave={() => setHoveredSuggestionGroup(null)}
                                    title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                    p={0}
                                    minW="16px"
                                    h="16px"
                                >
                                    <BundleSuggestionIcon size={10} color={suggestionEntry.color} />
                                </Button>
                            )}
                            {getEditingTxId() === tx.id ? (
                                <Button size="2xs" variant="ghost" onClick={cancelEdit} title="Cancel (Esc)" p={0} minW="16px" h="16px">
                                    ✗
                                </Button>
                            ) : (
                                <>
                                    <Button
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette="blue"
                                        onClick={() => {
                                            setDrawerTransactionId(tx.id);
                                            setIsDrawerOpen(true);
                                        }}
                                        title="Edit all fields"
                                        p={0}
                                        minW="16px"
                                        h="16px"
                                    >
                                        <LuPencil size={10} />
                                    </Button>
                                    <Button
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette="red"
                                        onClick={() => {
                                            setTransactionToDelete(tx);
                                            fetchDeletionImpact([tx.id]);
                                            setShowDeleteDialog(true);
                                        }}
                                        title="Delete transaction"
                                        p={0}
                                        minW="16px"
                                        h="16px"
                                    >
                                        🗑️
                                    </Button>
                                </>
                            )}
                            {/* Additional plugin row actions */}
                            {additionalRowActions.map(action => {
                                const isVisible = action.isVisible ? action.isVisible(tx as Transaction) : true;
                                const isDisabled = action.isDisabled ? action.isDisabled(tx as Transaction) : false;
                                if (!isVisible) return null;
                                return (
                                    <Button
                                        key={action.id}
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette={action.colorPalette || 'gray'}
                                        onClick={() => action.onClick(tx as Transaction)}
                                        disabled={isDisabled}
                                        title={action.label}
                                        p={0}
                                        minW="16px"
                                        h="16px"
                                    >
                                        {action.icon}
                                    </Button>
                                );
                            })}
                        </Flex>
                    </Table.Cell>
                )}
            </Table.Row>
        </React.Fragment>
    );

}, arePropsEqual);
