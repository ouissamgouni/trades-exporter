/**
 * ChartFullscreenModal
 *
 * Fixed-position fullscreen overlay for charts.
 * Pattern reused from SlidePanel — backdrop + content panel.
 */
import React from 'react';
import { Button } from '../ui/primitives';
import { FiX } from 'react-icons/fi';

interface ChartFullscreenModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}

export const ChartFullscreenModal: React.FC<ChartFullscreenModalProps> = ({
    isOpen,
    onClose,
    title,
    children,
}) => {
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-[99] bg-black/50"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
            />

            {/* Panel */}
            <div
                className="fixed z-[100] flex flex-col bg-white shadow-2xl"
                style={{ top: '5vh', left: '5vw', right: '5vw', bottom: '5vh' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2">
                    <span className="text-sm font-semibold text-slate-700">{title}</span>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <FiX size={18} />
                    </Button>
                </div>

                {/* Content — fills remaining space */}
                <div className="flex-1 overflow-auto p-4">
                    {children}
                </div>
            </div>
        </>
    );
};
