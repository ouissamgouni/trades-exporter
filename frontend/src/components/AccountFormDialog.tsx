import {
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    NativeSelect,
    Portal,
    Text,
    Textarea,
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { Account, API_URL } from '../types';

interface AccountFormDialogProps {
    isOpen: boolean;
    onClose: () => void;
    account?: Account | null;
}

const AccountFormDialog: React.FC<AccountFormDialogProps> = ({
    isOpen,
    onClose,
    account,
}) => {
    const [formData, setFormData] = useState({
        name: '',
        account_type: 'cex' as 'cex' | 'broker' | 'wallet',
        address_or_identifier: '',
        tags: [] as string[],
    });
    const [tagsInput, setTagsInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (account) {
            setFormData({
                name: account.name,
                account_type: account.account_type,
                address_or_identifier: account.address_or_identifier || '',
                tags: account.tags || [],
            });
            setTagsInput((account.tags || []).join(', '));
        } else {
            setFormData({
                name: '',
                account_type: 'cex',
                address_or_identifier: '',
                tags: [],
            });
            setTagsInput('');
        }
        setError('');
    }, [account, isOpen]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Parse tags from comma-separated input
            const tags = tagsInput
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag.length > 0);

            const payload = {
                ...formData,
                tags,
                address_or_identifier: formData.address_or_identifier || null,
            };

            const url = account
                ? `${API_URL}/accounts/${account.id}`
                : `${API_URL}/accounts/`;

            const method = account ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to save account');
            }

            onClose();
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }}>
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>
                                {account ? 'Edit Account' : 'Create New Account'}
                            </Dialog.Title>
                        </Dialog.Header>

                        <form onSubmit={handleSubmit}>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    {error && (
                                        <Text color="red.500" fontSize="sm">
                                            {error}
                                        </Text>
                                    )}

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Name <Text as="span" color="red.500">*</Text></Text>
                                        <Input
                                            value={formData.name}
                                            onChange={(e) =>
                                                setFormData({ ...formData, name: e.target.value })
                                            }
                                            placeholder="My Binance Account"
                                            required
                                        />
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Account Type <Text as="span" color="red.500">*</Text></Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={formData.account_type}
                                                onChange={(e) =>
                                                    setFormData({
                                                        ...formData,
                                                        account_type: e.target.value as 'cex' | 'broker' | 'wallet',
                                                    })
                                                }
                                            >
                                                <option value="cex">CEX (Centralized Exchange)</option>
                                                <option value="broker">Broker</option>
                                                <option value="wallet">Wallet</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Address or Identifier</Text>
                                        <Input
                                            value={formData.address_or_identifier}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    address_or_identifier: e.target.value,
                                                })
                                            }
                                            placeholder="0x1234... or account ID"
                                        />
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Tags</Text>
                                        <Textarea
                                            value={tagsInput}
                                            onChange={(e) => setTagsInput(e.target.value)}
                                            placeholder="trading, main, long-term"
                                            rows={2}
                                        />
                                        <Text fontSize="sm" color="gray.500" mt={1}>Comma-separated tags</Text>
                                    </Box>
                                </Flex>
                            </Dialog.Body>

                            <Dialog.Footer>
                                <Flex gap={3}>
                                    <Button
                                        variant="outline"
                                        onClick={onClose}
                                        disabled={loading}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="submit"
                                        colorPalette="blue"
                                        loading={loading}
                                    >
                                        {account ? 'Update' : 'Create'}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </form>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default AccountFormDialog;
