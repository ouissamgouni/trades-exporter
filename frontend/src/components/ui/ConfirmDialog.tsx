"use client"

import * as RadixDialog from '@radix-ui/react-dialog';
import React from 'react';
import { Button } from './primitives';

export interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isDestructive?: boolean;
    isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    isDestructive = false,
    isLoading = false,
}) => {
    const handleConfirm = async () => {
        await onConfirm();
        onClose();
    };

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                {/* Square corners by design system: no rounded utilities. */}
                <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
                    <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
                        <RadixDialog.Title className="text-base font-semibold text-slate-900 dark:text-slate-100">
                            {title}
                        </RadixDialog.Title>
                    </div>

                    <div className="px-5 py-4">
                        <RadixDialog.Description className="text-sm text-slate-600 dark:text-slate-300">
                            {message}
                        </RadixDialog.Description>
                    </div>

                    <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
                        <Button variant="outline" colorScheme="gray" onClick={onClose} disabled={isLoading}>
                            {cancelLabel}
                        </Button>
                        <Button
                            colorScheme={isDestructive ? 'red' : 'blue'}
                            onClick={handleConfirm}
                            loading={isLoading}
                        >
                            {confirmLabel}
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

// Hook for managing confirmation dialog state
export interface ConfirmDialogState<T = void> {
    isOpen: boolean;
    data: T | null;
}

export function useConfirmDialog<T = void>() {
    const [state, setState] = React.useState<ConfirmDialogState<T>>({
        isOpen: false,
        data: null,
    });

    const open = React.useCallback((data?: T) => {
        setState({ isOpen: true, data: data ?? null });
    }, []);

    const close = React.useCallback(() => {
        setState({ isOpen: false, data: null });
    }, []);

    return {
        isOpen: state.isOpen,
        data: state.data,
        open,
        close,
    };
}

export default ConfirmDialog;
