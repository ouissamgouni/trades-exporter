/**
 * TablePagination Component
 * 
 * Unified pagination UI for tables (Tailwind-based).
 * Features:
 * - Page navigation (first, prev, page numbers, next, last)
 * - Page size selector
 * - Item count display
 * - Compact mode for mobile
 * - Integration with usePagination hook
 * 
 * @example
 * // With usePagination hook
 * const pagination = usePagination({ storageKey: 'items', totalItems: data.total });
 * <TablePagination pagination={pagination} />
 * 
 * // Controlled mode (without hook)
 * <TablePagination
 *   page={currentPage}
 *   pageSize={pageSize}
 *   total={totalItems}
 *   onPageChange={setPage}
 *   onPageSizeChange={setPageSize}
 * />
 */

import React from 'react';
import { LuChevronLeft, LuChevronRight, LuChevronsLeft, LuChevronsRight } from 'react-icons/lu';
import { PAGE_SIZE_OPTIONS, type UsePaginationReturn } from '../hooks/usePagination';
import { Button } from './ui/primitives';

/**
 * Convert a Chakra-style spacing token (number, on the 0.25rem-per-unit scale)
 * or raw CSS size string into a CSS length.
 */
const toCssSize = (value: number | string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return typeof value === 'number' ? `${value * 0.25}rem` : value;
};

export interface TablePaginationProps {
    /** Pagination state from usePagination hook */
    pagination?: UsePaginationReturn;
    /** Current page (1-indexed) - use when not using pagination prop */
    page?: number;
    /** Items per page - use when not using pagination prop */
    pageSize?: number;
    /** Total number of items - use when not using pagination prop */
    total?: number;
    /** Callback when page changes - use when not using pagination prop */
    onPageChange?: (page: number) => void;
    /** Callback when page size changes - use when not using pagination prop */
    onPageSizeChange?: (size: number) => void;
    /** Available page size options */
    pageSizeOptions?: readonly number[];
    /** Show page size selector (default: true) */
    showPageSizeSelector?: boolean;
    /** Show item count text (default: true) */
    showItemCount?: boolean;
    /** Compact mode - fewer visible pages (default: false) */
    compact?: boolean;
    /** Size variant */
    size?: 'xs' | 'sm' | 'md';
    /** Hide when there's only one page (default: false) */
    hideOnSinglePage?: boolean;
    /** Additional CSS properties */
    mt?: number | string;
    mb?: number | string;
    p?: number | string;
}

export const TablePagination: React.FC<TablePaginationProps> = ({
    pagination,
    page: controlledPage,
    pageSize: controlledPageSize,
    total: controlledTotal,
    onPageChange: controlledOnPageChange,
    onPageSizeChange: controlledOnPageSizeChange,
    pageSizeOptions = PAGE_SIZE_OPTIONS,
    showPageSizeSelector = true,
    showItemCount = true,
    compact = false,
    size = 'sm',
    hideOnSinglePage = false,
    mt = 4,
    mb,
    p = 3,
}) => {
    // Resolve props from pagination hook or controlled props
    // Note: Use controlledTotal first if provided (for client-side pagination where total comes from array.length)
    const page = pagination?.page ?? controlledPage ?? 1;
    const pageSize = pagination?.pageSize ?? controlledPageSize ?? 50;
    const total = controlledTotal ?? pagination?.total ?? 0;
    const startItem = pagination?.startItem ?? (total === 0 ? 0 : (page - 1) * pageSize + 1);
    const endItem = pagination?.endItem ?? Math.min(page * pageSize, total);

    const handlePageChange = (newPage: number) => {
        if (pagination) {
            pagination.setPage(newPage);
        } else if (controlledOnPageChange) {
            controlledOnPageChange(newPage);
        }
    };

    const handlePageSizeChange = (newSize: number) => {
        if (pagination) {
            pagination.setPageSize(newSize);
        } else {
            controlledOnPageSizeChange?.(newSize);
        }
    };

    const totalPages = Math.ceil(total / pageSize);

    // Don't render if no items
    if (total === 0) {
        return null;
    }

    // Hide on single page if requested
    if (hideOnSinglePage && totalPages <= 1) {
        return null;
    }

    return (
        <div
            style={{ marginTop: toCssSize(mt), marginBottom: toCssSize(mb), padding: toCssSize(p) }}
            className="bg-slate-50 dark:bg-slate-800"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Left: page size selector as compact toggle buttons */}
                {showPageSizeSelector ? (
                    <div className="flex items-center gap-0">
                        {pageSizeOptions.map(option => (
                            <Button
                                key={option}
                                size="xs"
                                variant={pageSize === option ? 'solid' : 'outline'}
                                colorScheme={pageSize === option ? 'blue' : 'gray'}
                                onClick={() => handlePageSizeChange(option)}
                                className="h-6 px-2 font-normal"
                                aria-label={`${option} per page`}
                            >
                                {option}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <span />
                )}

                {/* Center: item count / range */}
                {showItemCount && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                        {startItem}–{endItem} of {total}
                    </span>
                )}

                {/* Right: page navigation */}
                {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                        <Button
                            size="xs"
                            variant="ghost"
                            aria-label="First page"
                            className="h-6 px-1"
                            onClick={() => handlePageChange(1)}
                            disabled={page === 1}
                        >
                            <LuChevronsLeft size={14} />
                        </Button>
                        <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Previous page"
                            className="h-6 px-1"
                            disabled={page === 1}
                            onClick={() => handlePageChange(page - 1)}
                        >
                            <LuChevronLeft size={14} />
                        </Button>
                        <span className="px-1 text-xs text-slate-600 dark:text-slate-300">
                            {page}/{totalPages}
                        </span>
                        <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Next page"
                            className="h-6 px-1"
                            disabled={page >= totalPages}
                            onClick={() => handlePageChange(page + 1)}
                        >
                            <LuChevronRight size={14} />
                        </Button>
                        <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Last page"
                            className="h-6 px-1"
                            disabled={page >= totalPages}
                            onClick={() => handlePageChange(totalPages)}
                        >
                            <LuChevronsRight size={14} />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TablePagination;
