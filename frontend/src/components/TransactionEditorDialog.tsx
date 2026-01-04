import { Dialog, Portal, Box, IconButton } from '@chakra-ui/react';
import React from 'react';
import { Transaction } from '../types';
import { ManualTransactionForm } from './ManualTransactionForm';
import { LuX } from 'react-icons/lu';

export interface TransactionEditorDialogProps {
    transaction: Transaction | null;
    isOpen: boolean;
    onClose: () => void;
}

/**
 * Dialog wrapper for editing transactions using ManualTransactionForm.
 * Displays the form in a large modal dialog for comprehensive editing.
 */
export const TransactionEditorDialog: React.FC<TransactionEditorDialogProps> = ({
    transaction,
    isOpen,
    onClose,
}) => {
    if (!transaction) return null;

    return (
        <Dialog.Root 
            open={isOpen} 
            onOpenChange={(e) => !e.open && onClose()}
            size="xl"
            scrollBehavior="inside"
        >
            <Portal>
                <Dialog.Backdrop bg="blackAlpha.600" />
                <Dialog.Positioner>
                    <Dialog.Content 
                        maxW="1200px" 
                        maxH="90vh"
                        borderRadius="xl"
                        overflow="hidden"
                    >
                        <Dialog.CloseTrigger asChild position="absolute" top={3} right={3}>
                            <IconButton
                                aria-label="Close dialog"
                                variant="ghost"
                                size="sm"
                            >
                                <LuX />
                            </IconButton>
                        </Dialog.CloseTrigger>
                        <Dialog.Body p={0} overflow="auto">
                            <Box p={6}>
                                <ManualTransactionForm
                                    mode="edit"
                                    transaction={transaction}
                                    onSuccess={onClose}
                                    onCancel={onClose}
                                />
                            </Box>
                        </Dialog.Body>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default TransactionEditorDialog;
