/**
 * @deprecated Use TablePagination and usePagination hook instead.
 * This component is kept for backward compatibility but should not be used in new code.
 * 
 * Pagination Controls Component
 * 
 * Reusable pagination UI for P&L Audit tabs with:
 * - Page navigation (first, prev, page numbers, next, last)
 * - Page size selector with localStorage persistence
 * - Total count display
 */

import React, { useEffect } from 'react';
import { Box, Button, Flex, NativeSelect, Text } from '@chakra-ui/react';

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

// localStorage key prefix for page size persistence
const PAGE_SIZE_STORAGE_KEY_PREFIX = 'pnl_audit_page_size_';

interface PaginationControlsProps {
    /** Current page (1-indexed) */
    currentPage: number;
    /** Total number of items */
    totalItems: number;
    /** Items per page */
    pageSize: number;
    /** Callback when page changes */
    onPageChange: (page: number) => void;
    /** Callback when page size changes */
    onPageSizeChange: (size: number) => void;
    /** Storage key suffix for persisting page size (e.g., 'units', 'lots') */
    storageKeySuffix?: string;
    /** Show compact version (fewer page numbers) */
    compact?: boolean;
}

/**
 * Get persisted page size from localStorage
 */
export const getPersistedPageSize = (keySuffix: string): number => {
    try {
        const stored = localStorage.getItem(`${PAGE_SIZE_STORAGE_KEY_PREFIX}${keySuffix}`);
        if (stored) {
            const parsed = parseInt(stored, 10);
            if (PAGE_SIZE_OPTIONS.includes(parsed)) {
                return parsed;
            }
        }
    } catch {
        // localStorage not available
    }
    return DEFAULT_PAGE_SIZE;
};

/**
 * Persist page size to localStorage
 */
const persistPageSize = (keySuffix: string, size: number): void => {
    try {
        localStorage.setItem(`${PAGE_SIZE_STORAGE_KEY_PREFIX}${keySuffix}`, String(size));
    } catch {
        // localStorage not available
    }
};

export const PaginationControls: React.FC<PaginationControlsProps> = ({
    currentPage,
    totalItems,
    pageSize,
    onPageChange,
    onPageSizeChange,
    storageKeySuffix,
    compact = false,
}) => {
    const totalPages = Math.ceil(totalItems / pageSize);
    const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const endItem = Math.min(currentPage * pageSize, totalItems);

    // Persist page size changes
    useEffect(() => {
        if (storageKeySuffix) {
            persistPageSize(storageKeySuffix, pageSize);
        }
    }, [pageSize, storageKeySuffix]);

    const goToPage = (page: number) => {
        if (page >= 1 && page <= totalPages && page !== currentPage) {
            onPageChange(page);
        }
    };

    const handlePageSizeChange = (newSize: number) => {
        // Note: Parent is responsible for resetting to page 1 with new size
        // The onPageSizeChange handler should handle both the size change and page reset
        onPageSizeChange(newSize);
    };

    // Generate page numbers to display
    const getPageNumbers = (): number[] => {
        const maxVisible = compact ? 3 : 5;
        const pages: number[] = [];

        if (totalPages <= maxVisible) {
            for (let i = 1; i <= totalPages; i++) {
                pages.push(i);
            }
        } else if (currentPage <= Math.ceil(maxVisible / 2)) {
            for (let i = 1; i <= maxVisible; i++) {
                pages.push(i);
            }
        } else if (currentPage >= totalPages - Math.floor(maxVisible / 2)) {
            for (let i = totalPages - maxVisible + 1; i <= totalPages; i++) {
                pages.push(i);
            }
        } else {
            const half = Math.floor(maxVisible / 2);
            for (let i = currentPage - half; i <= currentPage + half; i++) {
                pages.push(i);
            }
        }

        return pages;
    };

    if (totalItems === 0) {
        return null;
    }

    return (
        <Box mt={4} p={3} bg="gray.50" borderRadius="md">
            <Flex justify="space-between" align="center" flexWrap="wrap" gap={3}>
                {/* Left: Item count info */}
                <Text fontSize="sm" color="gray.600">
                    Showing {startItem}-{endItem} of <strong>{totalItems}</strong> items
                </Text>

                {/* Center: Page navigation */}
                {totalPages > 1 && (
                    <Flex align="center" gap={1}>
                        {/* First page */}
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => goToPage(1)}
                            disabled={currentPage === 1}
                            aria-label="First page"
                        >
                            ⟪
                        </Button>

                        {/* Previous page */}
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => goToPage(currentPage - 1)}
                            disabled={currentPage === 1}
                            aria-label="Previous page"
                        >
                            ←
                        </Button>

                        {/* Page numbers */}
                        {getPageNumbers().map(pageNum => (
                            <Button
                                key={pageNum}
                                size="xs"
                                variant={currentPage === pageNum ? 'solid' : 'outline'}
                                colorPalette={currentPage === pageNum ? 'blue' : undefined}
                                onClick={() => goToPage(pageNum)}
                                aria-label={`Page ${pageNum}`}
                                aria-current={currentPage === pageNum ? 'page' : undefined}
                            >
                                {pageNum}
                            </Button>
                        ))}

                        {/* Next page */}
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => goToPage(currentPage + 1)}
                            disabled={currentPage === totalPages}
                            aria-label="Next page"
                        >
                            →
                        </Button>

                        {/* Last page */}
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => goToPage(totalPages)}
                            disabled={currentPage === totalPages}
                            aria-label="Last page"
                        >
                            ⟫
                        </Button>
                    </Flex>
                )}

                {/* Right: Page size selector */}
                <Flex align="center" gap={2}>
                    <Text fontSize="sm" color="gray.600">Per page:</Text>
                    <NativeSelect.Root size="sm" width="75px">
                        <NativeSelect.Field
                            value={pageSize}
                            onChange={e => handlePageSizeChange(Number(e.target.value))}
                            aria-label="Items per page"
                        >
                            {PAGE_SIZE_OPTIONS.map(size => (
                                <option key={size} value={size}>{size}</option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
            </Flex>
        </Box>
    );
};

export default PaginationControls;
