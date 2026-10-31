/**
 * Column Visibility Popover Component
 * 
 * A dropdown menu that allows users to toggle column visibility.
 * Integrates with TanStack Table's column visibility state.
 */

import React, { useState, useRef, useEffect } from 'react';
import { LuColumns2, LuRefreshCw, LuChevronDown } from 'react-icons/lu';
import { Table as TanStackTable } from '@tanstack/react-table';
import { Transaction } from '../../types';
import { COLUMN_META } from './columnPresets';
import { TransactionColumnKey } from './types';
import { Button } from '../ui/primitives';
import type { ButtonProps } from '../ui/primitives';

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
    size?: NonNullable<ButtonProps['size']>;
}

// ============================================================================
// Component
// ============================================================================

export const ColumnVisibilityPopover = <T extends Transaction = Transaction>({
    table,
    onReset,
    size = 'sm',
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
        <div className="relative" ref={popoverRef}>
            <Button
                size={size}
                variant="outline"
                onClick={() => setIsOpen(!isOpen)}
                title="Toggle column visibility"
            >
                <LuColumns2 />
                <span className="ml-1">Columns ({visibleCount})</span>
                <LuChevronDown style={{ marginLeft: 4 }} />
            </Button>

            {isOpen && (
                <div className="absolute right-0 top-full z-[1000] mt-1 max-h-[400px] w-[280px] max-w-[calc(100vw-1rem)] overflow-y-auto border border-slate-200 bg-white p-3 shadow-lg">
                    <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-medium">
                            Visible Columns
                        </span>
                        {onReset && (
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={onReset}
                            >
                                <LuRefreshCw size={12} />
                                <span className="ml-1">Reset</span>
                            </Button>
                        )}
                    </div>

                    {/* Quick Actions */}
                    <div className="mb-3 flex gap-2">
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
                    </div>

                    {/* Grouped Columns */}
                    <div className="flex flex-col items-stretch gap-3">
                        {COLUMN_GROUPS.map(group => {
                            const groupColumns = allColumns.filter(col =>
                                group.columns.includes(col.id as TransactionColumnKey)
                            );

                            if (groupColumns.length === 0) return null;

                            return (
                                <div key={group.label}>
                                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                                        {group.label}
                                    </span>
                                    <div className="flex flex-col items-stretch gap-1 pl-2">
                                        {groupColumns.map(column => {
                                            const meta = COLUMN_META[column.id as TransactionColumnKey];
                                            const canHide = column.getCanHide();

                                            return (
                                                <div
                                                    key={column.id}
                                                    className="flex items-center justify-between py-0.5"
                                                    style={{ opacity: canHide ? 1 : 0.5 }}
                                                >
                                                    <label className="flex items-center gap-2">
                                                        <input
                                                            type="checkbox"
                                                            checked={column.getIsVisible()}
                                                            onChange={(e) => {
                                                                column.toggleVisibility(e.target.checked);
                                                            }}
                                                            disabled={!canHide}
                                                        />
                                                        <span className="text-xs">
                                                            {meta?.header || column.id}
                                                        </span>
                                                    </label>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Footer */}
                    <div className="mt-3 border-t border-slate-200 pt-2">
                        <span className="text-xs text-slate-500">
                            {visibleCount} of {totalCount} columns visible
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
};
