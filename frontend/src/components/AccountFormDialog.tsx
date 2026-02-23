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

export interface AccountPrefill {
    name?: string;
    account_type?: 'cex' | 'broker' | 'wallet';
    address_or_identifier?: string;
    group?: string;
}

interface AccountFormDialogProps {
    isOpen: boolean;
    onClose: (createdAccountId?: number) => void;
    account?: Account | null;
    prefill?: AccountPrefill;
}

const AccountFormDialog: React.FC<AccountFormDialogProps> = ({
    isOpen,
    onClose,
    account,
    prefill,
}) => {
    const [formData, setFormData] = useState({
        name: '',
        account_type: 'cex' as 'cex' | 'broker' | 'wallet',
        address_or_identifier: '',
        group: '',
        tags: [] as Record<string, any>[],
        owned: true,
    });
    const [tagsInput, setTagsInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
    const [existingAccounts, setExistingAccounts] = useState<Account[]>([]);

    // Fetch existing accounts for duplicate detection
    useEffect(() => {
        const fetchAccounts = async () => {
            try {
                const response = await fetch(`${API_URL}/accounts`);
                if (response.ok) {
                    const data = await response.json();
                    setExistingAccounts(data);
                }
            } catch (err) {
                console.error('Failed to fetch accounts for duplicate check:', err);
            }
        };
        if (isOpen) {
            fetchAccounts();
        }
    }, [isOpen]);

    useEffect(() => {
        if (account) {
            setFormData({
                name: account.name,
                account_type: account.account_type,
                address_or_identifier: account.address_or_identifier || '',
                group: account.group || '',
                tags: account.tags || [],
                owned: account.owned,
            });
            // Convert [{key: val}, ...] to "key, key2, ..."
            const tagStrings = (account.tags || []).map(tagObj => Object.keys(tagObj)[0]).filter(Boolean);
            setTagsInput(tagStrings.join(', '));
        } else if (prefill) {
            // Use prefill data when creating from raw account
            setFormData({
                name: prefill.name || '',
                account_type: prefill.account_type || 'cex',
                address_or_identifier: prefill.address_or_identifier || '',
                group: prefill.group || '',
                tags: [],
                owned: true,
            });
            setTagsInput('');
        } else {
            setFormData({
                name: '',
                account_type: 'cex',
                address_or_identifier: '',
                group: '',
                tags: [],
                owned: true,
            });
            setTagsInput('');
        }
        setError('');
        setDuplicateWarning(null);
    }, [account, prefill, isOpen]);

    // Check for duplicate address_or_identifier
    useEffect(() => {
        if (!formData.address_or_identifier || account) {
            setDuplicateWarning(null);
            return;
        }
        const duplicate = existingAccounts.find(
            acc => acc.address_or_identifier?.toLowerCase() === formData.address_or_identifier.toLowerCase()
        );
        if (duplicate) {
            setDuplicateWarning(`An account with this address/identifier already exists: "${duplicate.name}"`);
        } else {
            setDuplicateWarning(null);
        }
    }, [formData.address_or_identifier, existingAccounts, account]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Parse tags from comma-separated input and convert to [{key: true}, ...]
            const tagStrings = tagsInput
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag.length > 0);

            const tags = tagStrings.map(tag => ({ [tag]: true }));

            const payload = {
                ...formData,
                tags,
                address_or_identifier: formData.address_or_identifier || null,
                group: formData.group || null,
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

            // Get the created/updated account ID from response
            const responseData = await response.json();
            const createdId = responseData?.id;
            onClose(createdId);
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(undefined); }}>
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

                                    {duplicateWarning && (
                                        <Box bg="orange.50" p={3} borderRadius="md" borderWidth={1} borderColor="orange.200">
                                            <Text color="orange.700" fontSize="sm">
                                                ⚠️ {duplicateWarning}
                                            </Text>
                                        </Box>
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
                                        <Text fontWeight="medium" mb={1}>Group</Text>
                                        <Input
                                            value={formData.group}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    group: e.target.value,
                                                })
                                            }
                                            placeholder="e.g. Tangem EVM, Metamask EVM"
                                        />
                                        <Text fontSize="sm" color="gray.500" mt={1}>
                                            Optional label to group related accounts (e.g. same wallet on multiple chains)
                                        </Text>
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Owned <Text as="span" color="red.500">*</Text></Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={formData.owned ? 'true' : 'false'}
                                                onChange={(e) =>
                                                    setFormData({
                                                        ...formData,
                                                        owned: e.target.value === 'true',
                                                    })
                                                }
                                            >
                                                <option value="true">Yes (my account)</option>
                                                <option value="false">No (external/counterparty)</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                        <Text fontSize="sm" color="gray.500" mt={1}>
                                            Mark as owned if this account belongs to you. External accounts are used for tracking counterparties.
                                        </Text>
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
                                        onClick={() => onClose(undefined)}
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
