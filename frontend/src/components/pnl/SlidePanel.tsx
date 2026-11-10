/**
 * SlidePanel
 * 
 * Reusable slide-in panel with backdrop overlay.
 * Closes when clicking outside (backdrop) to solve the test-mode banner
 * potentially hiding the close button.
 */

import React from 'react';
import { Button } from '../ui/primitives';
import { FiX } from 'react-icons/fi';

interface SlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    titleIcon?: React.ReactNode;
    /** Extra controls rendered left of the close button */
    headerActions?: React.ReactNode;
    width?: string;
    zIndex?: number;
    children: React.ReactNode;
}

export const SlidePanel: React.FC<SlidePanelProps> = ({
    isOpen,
    onClose,
    title,
    titleIcon,
    headerActions,
    width = '600px',
    zIndex = 100,
    children,
}) => {
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop overlay - clicking closes the panel */}
            <div
                className="fixed inset-0 cursor-pointer bg-black/40"
                style={{ zIndex: zIndex - 1 }}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
            />

            {/*
             * Panel: mobile = bottom sheet (slides up, full width, max 90vh);
             * sm+ = right-side panel with the configured width.
             */}
            <div
                className={
                    'fixed inset-x-0 bottom-0 top-auto flex max-h-[90vh] w-full max-w-full flex-col ' +
                    'overflow-hidden border-t border-slate-200 bg-white shadow-xl animate-slide-up ' +
                    'sm:inset-x-auto sm:right-0 sm:top-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[90vw] ' +
                    'sm:border-l sm:border-t-0 sm:animate-none'
                }
                style={{ ['--sheet-w' as string]: width, zIndex }}
                onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
            >
                {/* Header */}
                <div className="sticky top-0 z-[1] flex flex-shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 p-4">
                    <div className="flex min-w-0 items-center gap-2">
                        {titleIcon}
                        <span className="truncate text-base font-semibold">{title}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {headerActions}
                        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
                            <FiX size={20} />
                        </Button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {children}
                </div>
            </div>
        </>
    );
};

export default SlidePanel;
