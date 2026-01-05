"use client"

import {
    Button,
    Dialog,
    Flex,
    Portal,
    Text,
} from '@chakra-ui/react';
import React from 'react';

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
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>{title}</Dialog.Title>
                        </Dialog.Header>

                        <Dialog.Body>
                            <Text>{message}</Text>
                        </Dialog.Body>

                        <Dialog.Footer>
                            <Flex gap={3}>
                                <Button
                                    variant="outline"
                                    onClick={onClose}
                                    disabled={isLoading}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    colorPalette={isDestructive ? 'red' : 'blue'}
                                    onClick={handleConfirm}
                                    loading={isLoading}
                                >
                                    {confirmLabel}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
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
