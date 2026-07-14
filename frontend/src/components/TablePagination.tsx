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
 * Compute the list of page numbers (with 'ellipsis' markers) to display,
 * mirroring the page-range algorithm previously provided by Chakra's Pagination.Context.
 */
const getPageItems = (current: number, total: number, siblingCount: number): (number | 'ellipsis')[] => {
    const totalPageNumbers = siblingCount * 2 + 5;
    if (total <= totalPageNumbers) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const leftSibling = Math.max(current - siblingCount, 1);
    const rightSibling = Math.min(current + siblingCount, total);
    const showLeftEllipsis = leftSibling > 2;
    const showRightEllipsis = rightSibling < total - 1;

    const items: (number | 'ellipsis')[] = [1];
    if (showLeftEllipsis) items.push('ellipsis');
    for (let i = Math.max(leftSibling, 2); i <= Math.min(rightSibling, total - 1); i++) {
        items.push(i);
    }
    if (showRightEllipsis) items.push('ellipsis');
    if (total > 1) items.push(total);
    return items;
};

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
        console.log('[TablePagination] handlePageChange called with:', newPage, 'pagination:', !!pagination);
        if (pagination) {
            console.log('[TablePagination] Calling pagination.setPage');
            pagination.setPage(newPage);
        } else if (controlledOnPageChange) {
            console.log('[TablePagination] Calling controlledOnPageChange');
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
        <div style={{ marginTop: toCssSize(mt), marginBottom: toCssSize(mb), padding: toCssSize(p) }} className="bg-slate-50 dark:bg-slate-800">
            <div className="flex flex-col flex-wrap items-center justify-between gap-3 md:flex-row">
                {/* Left: Item count info */}
                {showItemCount && (
                    <span className="text-xs text-slate-600 dark:text-slate-400">
                        Showing {startItem}-{endItem} of <strong>{total}</strong> items
                    </span>
                )}

                {/* Center: Page navigation */}
                {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                        <Button
                            size={size === 'xs' ? 'sm' : size}
                            variant="outline"
                            aria-label="First page"
                            onClick={() => handlePageChange(1)}
                            disabled={page === 1}
                            className="px-2"
                        >
                            <LuChevronsLeft />
                        </Button>

                        <Button
                            size={size === 'xs' ? 'sm' : size}
                            variant="outline"
                            aria-label="Previous page"
                            className="px-2"
                            disabled={page === 1}
                            onClick={() => handlePageChange(page - 1)}
                        >
                            <LuChevronLeft />
                        </Button>

                        {getPageItems(page, totalPages, compact ? 0 : 1).map((pageItem, index) =>
                            pageItem === 'ellipsis' ? (
                                <span key={`ellipsis-${index}`}>…</span>
                            ) : (
                                <Button
                                    key={pageItem}
                                    size={size === 'xs' ? 'sm' : size}
                                    variant={pageItem === page ? 'solid' : 'outline'}
                                    colorScheme={pageItem === page ? 'blue' : undefined}
                                    onClick={() => handlePageChange(pageItem)}
                                >
                                    {pageItem}
                                </Button>
                            )
                        )}

                        <Button
                            size={size === 'xs' ? 'sm' : size}
                            variant="outline"
                            aria-label="Next page"
                            className="px-2"
                            disabled={page === totalPages}
                            onClick={() => handlePageChange(page + 1)}
                        >
                            <LuChevronRight />
                        </Button>

                        <Button
                            size={size === 'xs' ? 'sm' : size}
                            variant="outline"
                            aria-label="Last page"
                            onClick={() => handlePageChange(totalPages)}
                            disabled={page === totalPages}
                            className="px-2"
                        >
                            <LuChevronsRight />
                        </Button>
                    </div>
                )}

                {/* Right: Page size selector */}
                {showPageSizeSelector && (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-600 dark:text-slate-400">
                            Per page:
                        </span>
                        <select
                            className="h-8 w-[75px] border border-slate-300 bg-white px-1 text-sm"
                            value={pageSize}
                            onChange={e => handlePageSizeChange(Number(e.target.value))}
                            aria-label="Items per page"
                        >
                            {pageSizeOptions.map(option => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TablePagination;
