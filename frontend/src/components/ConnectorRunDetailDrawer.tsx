/**
 * ConnectorRunDetailDrawer - Resizable drawer for connector run details
 * Wraps ConnectorRunDetailPanel in a custom resizable drawer with the same
 * functionality as JobDetailDrawer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuX } from 'react-icons/lu';
import { ConnectorRunDetailPanel } from './ConnectorRunDetailPanel';
import { Button } from './ui/primitives';

interface ConnectorRunDetailDrawerProps {
    runId: number;
    open: boolean;
    onClose: () => void;
    enablePolling?: boolean;
}

export const ConnectorRunDetailDrawer: React.FC<ConnectorRunDetailDrawerProps> = ({
    runId,
    open,
    onClose,
    enablePolling = false,
}) => {
    // Resizable width state
    const [drawerWidth, setDrawerWidth] = useState<number>(() => {
        const saved = localStorage.getItem('connectorRunDetailDrawerWidth');
        return saved ? parseInt(saved, 10) : 900;
    });
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartX = useRef<number>(0);
    const resizeStartWidth = useRef<number>(0);

    // Resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsResizing(true);
        resizeStartX.current = e.clientX;
        resizeStartWidth.current = drawerWidth;
    }, [drawerWidth]);

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!isResizing) return;
        const deltaX = resizeStartX.current - e.clientX;
        const newWidth = Math.max(600, Math.min(window.innerWidth * 0.95, resizeStartWidth.current + deltaX));
        setDrawerWidth(newWidth);
    }, [isResizing]);

    const handleResizeEnd = useCallback(() => {
        if (!isResizing) return;
        setIsResizing(false);
        localStorage.setItem('connectorRunDetailDrawerWidth', drawerWidth.toString());
    }, [isResizing, drawerWidth]);

    // Add/remove resize event listeners
    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', handleResizeEnd);
            return () => {
                document.removeEventListener('mousemove', handleResizeMove);
                document.removeEventListener('mouseup', handleResizeEnd);
            };
        }
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    if (!open) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-[1000] bg-black/40"
                onClick={onClose}
            />

            {/* Drawer Panel: bottom sheet on mobile, right-side panel on sm+ */}
            <div
                className="fixed inset-x-0 bottom-0 top-auto z-[1001] flex max-h-[90vh] w-full max-w-full flex-col overflow-hidden border-t border-slate-200 bg-white shadow-xl dark:bg-slate-900 sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[95vw] sm:border-t-0"
                style={{ ['--sheet-w' as string]: `${drawerWidth}px` }}
            >
                {/* Resize Handle (desktop only) */}
                <div
                    className={`absolute inset-y-0 left-0 z-[1] hidden w-1 cursor-col-resize transition-colors hover:bg-blue-200 sm:block ${isResizing ? 'bg-blue-400' : 'bg-transparent'}`}
                    onMouseDown={handleResizeStart}
                />
                {/* Header */}
                <div className="flex items-center justify-between border-b px-4 py-3">
                    <span className="text-base font-semibold">
                        Connector Run Details
                    </span>
                    <Button
                        aria-label="Close"
                        variant="ghost"
                        colorScheme="gray"
                        size="sm"
                        onClick={onClose}
                    >
                        <LuX />
                    </Button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-auto p-4">
                    <ConnectorRunDetailPanel
                        runId={runId}
                        enablePolling={enablePolling}
                    />
                </div>
            </div>
        </>
    );
};

export default ConnectorRunDetailDrawer;
