/**
 * UnifiedIssueTransactionTable
 * 
 * Unified table component for displaying transaction issues across all Data Health tabs.
 * Supports configurable columns, action renderers, bulk selection, and pagination.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    HStack,
    Input,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import {
    FiArrowDown,
    FiArrowUp,
    FiCheck,
    FiCheckCircle,
    FiChevronLeft,
    FiChevronRight,
    FiRepeat,
    FiX,
} from 'react-icons/fi';
import {
    Asset,
    Account,
    TransactionIssue,
    IssueType,
    PaginationMetadata,
} from '../types';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { SourceInfoCell } from './SourceInfoCell';

// =============================================================================
// Types & Configuration
// =============================================================================

export interface IssueTableColumn {
    key: string;
    label: string;
    width: string;
    render?: (issue: TransactionIssue) => React.ReactNode;
}

export interface ActionRendererProps {
    issue: TransactionIssue;
    assets: Asset[];
    accounts: Account[];
    onFixed: () => void;
    onAssetsUpdated?: () => void;
    onAccountsUpdated?: () => void;
}

export interface UnifiedIssueTransactionTableProps {
    // Data
    issues: TransactionIssue[];
    pagination: PaginationMetadata;

    // Table configuration
    columns: IssueTableColumn[];
    actionRenderer: (props: ActionRendererProps) => React.ReactNode;

    // Master data
    assets: Asset[];
    accounts: Account[];

    // Callbacks
    onFixed: () => void;
    onAssetsUpdated?: () => void;
    onAccountsUpdated?: () => void;
    onTransactionClick?: (txId: number) => void;
    onPageChange: (page: number) => void;

    // Loading states
    isLoading?: boolean;

    // Optional: Bulk selection support
    enableBulkSelection?: boolean;
    selectedIds?: Set<number>;
    onToggleSelection?: (id: number) => void;
    onToggleSelectAll?: () => void;
    bulkActions?: React.ReactNode;
}

// Column width constants - exported for use in action renderers
export const COLS = {
    CHECKBOX: '30px',
    ID: '55px',
    DATE: '80px',
    TX: '110px',
    TYPE: '120px',
    VALUE: '95px',
    SOURCE: '200px',
    ACTION: '155px',
} as const;

// Issue type configuration - exported for use in action renderers
export const ISSUE_CONFIG: Record<IssueType, {
    color: string;
    label: string;
    description: string
}> = {
    missing_source: {
        color: 'red',
        label: 'Missing Source',
        description: 'Transaction has no source field'
    },
    missing_source_asset: {
        color: 'red',
        label: 'Missing Asset',
        description: 'No asset and no source asset symbol'
    },
    missing_source_account: {
        color: 'red',
        label: 'Missing Account',
        description: 'No account and no source account'
    },
    unlinked_asset: {
        color: 'red',
        label: 'Unlinked Base Asset',
        description: 'Source asset symbol needs mapping'
    },
    unlinked_account: {
        color: 'orange',
        label: 'Unlinked Account',
        description: 'Source account needs mapping'
    },
    unlinked_price_quote: {
        color: 'purple',
        label: 'Unlinked Price Asset',
        description: 'Price quote asset needs mapping'
    },
    unlinked_fee_quote: {
        color: 'yellow',
        label: 'Unlinked Fee Asset',
        description: 'Fee quote asset needs mapping'
    },
    missing_transfer_from_account: {
        color: 'blue',
        label: 'Missing From Account',
        description: 'Inflow transfer missing source from account'
    },
    missing_transfer_to_account: {
        color: 'blue',
        label: 'Missing To Account',
        description: 'Outflow transfer missing source to account'
    },
    unlinked_transfer_from_account: {
        color: 'cyan',
        label: 'Unlinked From Account',
        description: 'Source from account needs mapping'
    },
    unlinked_transfer_to_account: {
        color: 'cyan',
        label: 'Unlinked To Account',
        description: 'Source to account needs mapping'
    },
};

// =============================================================================
// Utility Functions
// =============================================================================

export const formatDate = (dateStr: string): string => {
    try {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: '2-digit'
        });
    } catch {
        return dateStr.slice(0, 10);
    }
};

export const formatQty = (qty: number): string => {
    if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(1)}M`;
    if (qty >= 1_000) return `${(qty / 1_000).toFixed(1)}K`;
    if (qty >= 1) return qty.toFixed(2);
    if (qty >= 0.01) return qty.toFixed(4);
    return qty.toExponential(2);
};

// =============================================================================
// Sub-Components
// =============================================================================

/** Direction indicator icon */
export const DirectionIcon: React.FC<{ direction: string }> = ({ direction }) => {
    const icons: Record<string, JSX.Element> = {
        inflow: <FiArrowDown size={11} color="var(--chakra-colors-green-500)" />,
        outflow: <FiArrowUp size={11} color="var(--chakra-colors-red-500)" />,
    };
    return icons[direction] || <FiRepeat size={11} color="var(--chakra-colors-gray-400)" />;
};

/** Table header row */
const TableHeader: React.FC<{
    columns: IssueTableColumn[];
    enableBulkSelection?: boolean;
    allSelected?: boolean;
    onToggleSelectAll?: () => void;
}> = ({ columns, enableBulkSelection, allSelected, onToggleSelectAll }) => (
    <Flex
        px={2}
        py={1.5}
        bg="gray.50"
        borderBottomWidth={1}
        borderColor="gray.200"
        fontSize="xs"
        fontWeight="semibold"
        color="gray.500"
    >
        {enableBulkSelection && (
            <Box w={COLS.CHECKBOX} mr={1}>
                <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={onToggleSelectAll}
                    style={{ cursor: 'pointer', width: '14px', height: '14px' }}
                />
            </Box>
        )}
        {columns.map((col) => (
            <Box key={col.key} w={col.width}>
                {col.label}
            </Box>
        ))}
    </Flex>
);

/** Table row */
const IssueRow: React.FC<{
    issue: TransactionIssue;
    columns: IssueTableColumn[];
    actionRenderer: (props: ActionRendererProps) => React.ReactNode;
    assets: Asset[];
    accounts: Account[];
    onFixed: () => void;
    onAssetsUpdated?: () => void;
    onAccountsUpdated?: () => void;
    onTransactionClick?: (txId: number) => void;
    enableBulkSelection?: boolean;
    isSelected?: boolean;
    onToggleSelection?: () => void;
}> = ({
    issue,
    columns,
    actionRenderer,
    assets,
    accounts,
    onFixed,
    onAssetsUpdated,
    onAccountsUpdated,
    onTransactionClick,
    enableBulkSelection,
    isSelected,
    onToggleSelection,
}) => {
        const [isFixed, setIsFixed] = useState(false);

        const handleFixed = () => {
            setIsFixed(true);
            onFixed();
        };

        return (
            <Flex
                px={2}
                py={1.5}
                bg={isFixed ? 'green.50' : 'white'}
                borderBottomWidth={1}
                borderColor={isFixed ? 'green.200' : 'gray.100'}
                fontSize="xs"
                align="center"
                _hover={{ bg: isFixed ? 'green.50' : 'gray.25' }}
            >
                {enableBulkSelection && (
                    <Box w={COLS.CHECKBOX} mr={1}>
                        <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={onToggleSelection}
                            style={{ cursor: 'pointer', width: '14px', height: '14px' }}
                        />
                    </Box>
                )}
                {columns.map((col) => (
                    <Box key={col.key} w={col.width}>
                        {col.render ? col.render(issue) : null}
                    </Box>
                ))}
                {/* Action column - always last */}
                <Box flex="1">
                    {isFixed ? (
                        <Badge colorPalette="green" size="xs">
                            <FiCheckCircle size={10} />
                            <Text ml={1}>Done</Text>
                        </Badge>
                    ) : (
                        actionRenderer({
                            issue,
                            assets,
                            accounts,
                            onFixed: handleFixed,
                            onAssetsUpdated,
                            onAccountsUpdated,
                        })
                    )}
                </Box>
            </Flex>
        );
    };

/** Pagination controls */
const PaginationControls: React.FC<{
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    isLoading?: boolean;
}> = ({ currentPage, totalPages, onPageChange, isLoading }) => {
    if (totalPages <= 1) return null;

    return (
        <Flex justify="center" pt={2}>
            <HStack gap={2}>
                <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 1 || isLoading}
                >
                    <FiChevronLeft size={12} /> Prev
                </Button>
                <Text fontSize="xs" color="gray.500">
                    Page {currentPage} of {totalPages}
                </Text>
                <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage === totalPages || isLoading}
                >
                    Next <FiChevronRight size={12} />
                </Button>
            </HStack>
        </Flex>
    );
};

// =============================================================================
// Main Component
// =============================================================================

export const UnifiedIssueTransactionTable: React.FC<UnifiedIssueTransactionTableProps> = ({
    issues,
    pagination,
    columns,
    actionRenderer,
    assets,
    accounts,
    onFixed,
    onAssetsUpdated,
    onAccountsUpdated,
    onTransactionClick,
    onPageChange,
    isLoading = false,
    enableBulkSelection = false,
    selectedIds,
    onToggleSelection,
    onToggleSelectAll,
    bulkActions,
}) => {
    const totalPages = Math.ceil(pagination.total_count / pagination.per_page);
    const allCurrentPageSelected = issues.every((issue) =>
        selectedIds?.has(issue.transaction_id)
    );

    if (isLoading && issues.length === 0) {
        return (
            <Flex justify="center" py={8}>
                <Spinner size="md" />
            </Flex>
        );
    }

    if (issues.length === 0) {
        return (
            <Box p={3} bg="gray.50" borderRadius="md" textAlign="center">
                <Text fontSize="xs" color="gray.600">
                    No issues found
                </Text>
            </Box>
        );
    }

    return (
        <VStack gap={3} align="stretch">
            {/* Bulk actions toolbar */}
            {bulkActions}

            {/* Header with count and pagination */}
            <Flex justify="space-between" align="center">
                <Text fontSize="xs" fontWeight="medium" color="gray.600">
                    Issues ({pagination.total_count})
                </Text>
                {totalPages > 1 && (
                    <HStack gap={1}>
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => onPageChange(pagination.page - 1)}
                            disabled={pagination.page === 1 || isLoading}
                        >
                            <FiChevronLeft size={14} />
                        </Button>
                        <Text fontSize="xs" color="gray.500">
                            {pagination.page} / {totalPages}
                        </Text>
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => onPageChange(pagination.page + 1)}
                            disabled={pagination.page === totalPages || isLoading}
                        >
                            <FiChevronRight size={14} />
                        </Button>
                    </HStack>
                )}
            </Flex>

            {/* Table */}
            <Box borderWidth={1} borderColor="gray.200" borderRadius="md" overflow="visible">
                <TableHeader
                    columns={columns}
                    enableBulkSelection={enableBulkSelection}
                    allSelected={allCurrentPageSelected}
                    onToggleSelectAll={onToggleSelectAll}
                />
                {issues.map((issue, idx) => (
                    <IssueRow
                        key={`${issue.transaction_id}-${issue.issue_type}-${idx}`}
                        issue={issue}
                        columns={columns}
                        actionRenderer={actionRenderer}
                        assets={assets}
                        accounts={accounts}
                        onFixed={onFixed}
                        onAssetsUpdated={onAssetsUpdated}
                        onAccountsUpdated={onAccountsUpdated}
                        onTransactionClick={onTransactionClick}
                        enableBulkSelection={enableBulkSelection}
                        isSelected={selectedIds?.has(issue.transaction_id)}
                        onToggleSelection={
                            onToggleSelection
                                ? () => onToggleSelection(issue.transaction_id)
                                : undefined
                        }
                    />
                ))}
            </Box>

            {/* Bottom pagination */}
            <PaginationControls
                currentPage={pagination.page}
                totalPages={totalPages}
                onPageChange={onPageChange}
                isLoading={isLoading}
            />
        </VStack>
    );
};

export default UnifiedIssueTransactionTable;
