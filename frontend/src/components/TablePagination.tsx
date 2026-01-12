/**
 * TablePagination Component
 * 
 * Unified pagination UI for tables using Chakra UI v3 Pagination component.
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
import {
    Box,
    Button,
    Flex,
    HStack,
    NativeSelect,
    Pagination,
    Text,
} from '@chakra-ui/react';
import { LuChevronLeft, LuChevronRight, LuChevronsLeft, LuChevronsRight } from 'react-icons/lu';
import { PAGE_SIZE_OPTIONS, type UsePaginationReturn } from '../hooks/usePagination';

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

    const handlePageChange = (details: { page: number }) => {
        console.log('[TablePagination] handlePageChange called with:', details.page, 'pagination:', !!pagination);
        if (pagination) {
            console.log('[TablePagination] Calling pagination.setPage');
            pagination.setPage(details.page);
        } else if (controlledOnPageChange) {
            console.log('[TablePagination] Calling controlledOnPageChange');
            controlledOnPageChange(details.page);
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
        <Box mt={mt} mb={mb} p={p} bg="gray.50" borderRadius="md" _dark={{ bg: 'gray.800' }}>
            <Flex
                justify="space-between"
                align="center"
                flexWrap="wrap"
                gap={3}
                direction={{ base: 'column', md: 'row' }}
            >
                {/* Left: Item count info */}
                {showItemCount && (
                    <Text fontSize="sm" color="gray.600" _dark={{ color: 'gray.400' }}>
                        Showing {startItem}-{endItem} of <strong>{total}</strong> items
                    </Text>
                )}

                {/* Center: Page navigation */}
                {totalPages > 1 && (
                    <Pagination.Root
                        count={total}
                        pageSize={pageSize}
                        page={page}
                        onPageChange={handlePageChange}
                        siblingCount={compact ? 0 : 1}
                    >
                        <HStack gap={1}>
                            <Button
                                size={size}
                                variant="outline"
                                aria-label="First page"
                                onClick={() => handlePageChange({ page: 1 })}
                                disabled={page === 1}
                                px={2}
                            >
                                <LuChevronsLeft />
                            </Button>

                            <Button
                                size={size}
                                variant="outline"
                                aria-label="Previous page"
                                px={2}
                                disabled={page === 1}
                                onClick={() => handlePageChange({ page: page - 1 })}
                            >
                                <LuChevronLeft />
                            </Button>

                            <Pagination.Context>
                                {({ pages }) =>
                                    pages.map((pageItem, index) =>
                                        pageItem.type === 'page' ? (
                                            <Button
                                                key={index}
                                                size={size}
                                                variant={pageItem.value === page ? 'solid' : 'outline'}
                                                colorPalette={pageItem.value === page ? 'blue' : undefined}
                                                onClick={() => handlePageChange({ page: pageItem.value })}
                                            >
                                                {pageItem.value}
                                            </Button>
                                        ) : (
                                            <Text key={index}>…</Text>
                                        )
                                    )
                                }
                            </Pagination.Context>

                            <Button
                                size={size}
                                variant="outline"
                                aria-label="Next page"
                                px={2}
                                disabled={page === totalPages}
                                onClick={() => handlePageChange({ page: page + 1 })}
                            >
                                <LuChevronRight />
                            </Button>

                            <Button
                                size={size}
                                variant="outline"
                                aria-label="Last page"
                                onClick={() => handlePageChange({ page: totalPages })}
                                disabled={page === totalPages}
                                px={2}
                            >
                                <LuChevronsRight />
                            </Button>
                        </HStack>
                    </Pagination.Root>
                )}

                {/* Right: Page size selector */}
                {showPageSizeSelector && (
                    <Flex align="center" gap={2}>
                        <Text fontSize="sm" color="gray.600" _dark={{ color: 'gray.400' }}>
                            Per page:
                        </Text>
                        <NativeSelect.Root size="sm" width="75px">
                            <NativeSelect.Field
                                value={pageSize}
                                onChange={e => handlePageSizeChange(Number(e.target.value))}
                                aria-label="Items per page"
                            >
                                {pageSizeOptions.map(option => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>
                )}
            </Flex>
        </Box>
    );
};

export default TablePagination;
