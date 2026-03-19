/**
 * Column Visibility Popover Component
 * 
 * A dropdown menu that allows users to toggle column visibility.
 * Integrates with TanStack Table's column visibility state.
 */

import React, { useState, useRef, useEffect } from 'react';
import { Box, Button, Flex, Text, Checkbox, HStack, VStack } from '@chakra-ui/react';
import { LuColumns2, LuRefreshCw, LuChevronDown } from 'react-icons/lu';
import { Table as TanStackTable } from '@tanstack/react-table';
import { Transaction } from '../../types';
import { COLUMN_META } from './columnPresets';
import { TransactionColumnKey } from './types';

// ============================================================================
// Column Groups for organized display
// ============================================================================

interface ColumnGroup {
    label: string;
    columns: TransactionColumnKey[];
}

const COLUMN_GROUPS: ColumnGroup[] = [
    {
        label: 'Identifiers',
        columns: ['id', 'date', 'source', 'accounts', 'sourceTransactionId'],
    },
    {
        label: 'Classification',
        columns: ['direction', 'type', 'asset'],
    },
    {
        label: 'Values',
        columns: ['qty', 'price', 'total', 'fee'],
    },
    {
        label: 'Metadata',
        columns: ['taxability', 'feeInBase', 'bundle', 'tags', 'status'],
    },
];

// ============================================================================
// Props
// ============================================================================

interface ColumnVisibilityPopoverProps<T extends Transaction = Transaction> {
    /**
     * TanStack Table instance
     */
    table: TanStackTable<T>;
    
    /**
     * Callback to reset columns to defaults
     */
    onReset?: () => void;
    
    /**
     * Button size
     */
    size?: 'xs' | 'sm' | 'md';
}

// ============================================================================
// Component
// ============================================================================

export const ColumnVisibilityPopover = <T extends Transaction = Transaction>({
    table,
    onReset,
    size = 'xs',
}: ColumnVisibilityPopoverProps<T>) => {
    const [isOpen, setIsOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const allColumns = table.getAllLeafColumns();
    
    // Count visible columns
    const visibleCount = allColumns.filter(col => col.getIsVisible()).length;
    const totalCount = allColumns.filter(col => col.getCanHide()).length;
    
    // Close on outside click
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                popoverRef.current &&
                !popoverRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);
    
    return (
        <Box position="relative" ref={popoverRef}>
            <Button
                size={size}
                variant="outline"
                onClick={() => setIsOpen(!isOpen)}
                title="Toggle column visibility"
            >
                <LuColumns2 />
                <Text ml={1}>Columns ({visibleCount})</Text>
                <LuChevronDown style={{ marginLeft: 4 }} />
            </Button>
            
            {isOpen && (
                <Box
                    position="absolute"
                    top="100%"
                    right={0}
                    mt={1}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    zIndex={1000}
                    width="280px"
                    maxH="400px"
                    overflowY="auto"
                    p={3}
                >
                    <Flex justify="space-between" align="center" mb={3}>
                        <Text fontWeight="medium" fontSize="sm">
                            Visible Columns
                        </Text>
                        {onReset && (
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={onReset}
                            >
                                <LuRefreshCw size={12} />
                                <Text ml={1}>Reset</Text>
                            </Button>
                        )}
                    </Flex>
                    
                    {/* Quick Actions */}
                    <HStack gap={2} mb={3}>
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => table.toggleAllColumnsVisible(true)}
                        >
                            Show All
                        </Button>
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() => {
                                // Hide all except essential
                                allColumns.forEach(col => {
                                    const isEssential = ['date', 'source', 'asset', 'qty', 'status'].includes(col.id);
                                    col.toggleVisibility(isEssential);
                                });
                            }}
                        >
                            Minimal
                        </Button>
                    </HStack>
                    
                    {/* Grouped Columns */}
                    <VStack gap={3} align="stretch">
                        {COLUMN_GROUPS.map(group => {
                            const groupColumns = allColumns.filter(col => 
                                group.columns.includes(col.id as TransactionColumnKey)
                            );
                            
                            if (groupColumns.length === 0) return null;
                            
                            return (
                                <Box key={group.label}>
                                    <Text 
                                        fontSize="xs" 
                                        color="gray.500" 
                                        fontWeight="medium"
                                        mb={1}
                                        textTransform="uppercase"
                                        letterSpacing="wide"
                                    >
                                        {group.label}
                                    </Text>
                                    <VStack gap={1} align="stretch" pl={2}>
                                        {groupColumns.map(column => {
                                            const meta = COLUMN_META[column.id as TransactionColumnKey];
                                            const canHide = column.getCanHide();
                                            
                                            return (
                                                <Flex
                                                    key={column.id}
                                                    align="center"
                                                    justify="space-between"
                                                    py={0.5}
                                                    opacity={canHide ? 1 : 0.5}
                                                >
                                                    <Checkbox.Root
                                                        checked={column.getIsVisible()}
                                                        onCheckedChange={(checked) => {
                                                            column.toggleVisibility(!!checked.checked);
                                                        }}
                                                        disabled={!canHide}
                                                    >
                                                        <Checkbox.HiddenInput />
                                                        <Checkbox.Control />
                                                        <Checkbox.Label>
                                                            <Text fontSize="sm">
                                                                {meta?.header || column.id}
                                                            </Text>
                                                        </Checkbox.Label>
                                                    </Checkbox.Root>
                                                </Flex>
                                            );
                                        })}
                                    </VStack>
                                </Box>
                            );
                        })}
                    </VStack>
                    
                    {/* Footer */}
                    <Box mt={3} pt={2} borderTop="1px solid" borderColor="gray.200">
                        <Text fontSize="xs" color="gray.500">
                            {visibleCount} of {totalCount} columns visible
                        </Text>
                    </Box>
                </Box>
            )}
        </Box>
    );
};
