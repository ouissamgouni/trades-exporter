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
    width?: string;
    zIndex?: number;
    children: React.ReactNode;
}

export const SlidePanel: React.FC<SlidePanelProps> = ({
    isOpen,
    onClose,
    title,
    titleIcon,
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

            {/* Panel */}
            <div
                className="fixed bottom-0 right-0 top-0 overflow-y-auto border-l border-slate-200 bg-white shadow-xl"
                style={{ width, maxWidth: '90vw', zIndex }}
                onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
            >
                {/* Header */}
                <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center gap-2">
                        {titleIcon}
                        <span className="text-base font-semibold">{title}</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <FiX size={20} />
                    </Button>
                </div>

                {/* Content */}
                <div className="p-4">
                    {children}
                </div>
            </div>
        </>
    );
};

export default SlidePanel;
