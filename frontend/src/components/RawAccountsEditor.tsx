import { Box, Button, Dialog, Flex, Heading, Input, Portal, Text } from '@chakra-ui/react';
import React, { useState } from 'react';
import { API_URL, RawAccount } from '../types';
import { AccountMappingPanel } from './AccountMappingPanel';
import { toaster } from './ui/toaster';

export const RawAccountsEditor: React.FC = () => {
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newRawAccount, setNewRawAccount] = useState<Partial<RawAccount>>({});
    const [includeDismissed, setIncludeDismissed] = useState(false);

    const createRawAccount = async () => {
        if (!newRawAccount.label || !newRawAccount.source) {
            toaster.error({ title: 'Validation error', description: 'Label and Source are required' });
            return;
        }
        try {
            const response = await fetch(`${API_URL}/raw-accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newRawAccount)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create raw account');
            }
            setNewRawAccount({});
            setShowCreateDialog(false);
            toaster.success({ title: 'Raw account created' });
            // Force refresh by reloading
            window.location.reload();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create' });
        }
    };

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>🔗 Raw Accounts Mapping</Heading>
                    <Text color="gray.600" fontSize="sm">
                        Link source-specific account labels/addresses to normalized accounts.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                </Flex>
            </Flex>

            <AccountMappingPanel
                mode="full"
                includeDismissed={includeDismissed}
                onDismissedChange={setIncludeDismissed}
            />

            {/* Create Raw Account Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Add Raw Account Mapping</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source</Text>
                                        <Input
                                            value={newRawAccount.source || ''}
                                            onChange={(e) => setNewRawAccount({ ...newRawAccount, source: e.target.value })}
                                            placeholder="e.g., binance_trx, solana_helius"
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Label</Text>
                                        <Input
                                            value={newRawAccount.label || ''}
                                            onChange={(e) => setNewRawAccount({ ...newRawAccount, label: e.target.value })}
                                            placeholder="e.g., spot, 0x1234..."
                                        />
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Dialog.ActionTrigger asChild>
                                    <Button variant="outline">Cancel</Button>
                                </Dialog.ActionTrigger>
                                <Button colorPalette="blue" onClick={createRawAccount}>
                                    Create
                                </Button>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>
        </Box>
    );
};
