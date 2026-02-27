import {
    Badge, Box,
    Button, Card, Checkbox, Collapsible, Flex, Grid,
    GridItem, Heading, HStack, Input, NativeSelect, Spinner, Text
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Account, API_URL, Asset } from '../types';
import { useAssets } from '../hooks/useAssets';
import { Direction, ReviewStatus, TransactionType } from '../enums';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { ComboSelect, SOURCE_OPTIONS } from './ComboSelect';
import { Tooltip } from './ui/tooltip';
import {
    toDateTimeLocalString,
    dateTimeLocalToISO,
    formatDateTimeLocale,
} from '../utils/dateUtils';
import {
    getAssetSuggestions,
    getAccountSuggestions,
    getConfidenceColor,
    formatConfidence,
} from '../utils/similarity';

// Simplified transaction category using enum values
type SimplifiedType = typeof TransactionType.TRADE | typeof TransactionType.TRANSFER;

// Tag as key-value pair
interface Tag {
    key: string;
    value: string;
}

interface FormData {
    date_time: string;
    direction: string;
    simplified_type: SimplifiedType;
    transaction_type: string;  // Derived from simplified_type + direction
    source_transaction_type: string;
    source_transaction_id: string;
    source: string;
    source_account: string;  // Raw account identifier for suggestions
    account_id: number | null;
    from_account_id: number | null;  // For transfers
    to_account_id: number | null;    // For transfers
    quantity: string;
    source_asset_symbol: string;
    asset_id: number | null;
    price: string;
    source_price_quote_asset_symbol: string;
    price_quote_asset_id: number | null;
    total: string;
    fee: string;
    source_fee_quote_asset_symbol: string;
    fee_quote_asset_id: number | null;
    include_fee: boolean;
    disposal_taxable: boolean;
    from_address: string;
    to_address: string;
    network: string;
    network_transaction_id: string;
    token_contract_address: string;
    review_status: string;
    review_notes: string;
    tags: Tag[];  // Tags as key-value pairs
}

const initialFormData: FormData = {
    date_time: '',
    direction: Direction.INFLOW,
    simplified_type: TransactionType.TRADE,
    transaction_type: TransactionType.TRADE,
    source_transaction_type: '',
    source_transaction_id: '',
    source: 'manual',
    source_account: '',
    account_id: null,
    from_account_id: null,
    to_account_id: null,
    quantity: '',
    source_asset_symbol: '',
    asset_id: null,
    price: '',
    source_price_quote_asset_symbol: '',
    price_quote_asset_id: null,
    total: '',
    fee: '',
    source_fee_quote_asset_symbol: '',
    fee_quote_asset_id: null,
    include_fee: true,
    disposal_taxable: false,
    from_address: '',
    to_address: '',
    network: '',
    network_transaction_id: '',
    token_contract_address: '',
    review_status: ReviewStatus.PENDING,
    review_notes: '',
    tags: [],
};

// Derive transaction_type from simplified_type + direction
const deriveTransactionType = (simplifiedType: SimplifiedType, direction: string): string => {
    if (simplifiedType === TransactionType.TRANSFER) {
        return TransactionType.TRANSFER;
    }
    // Trade - direction determines buy/sell semantics at runtime
    return TransactionType.TRADE;
};

// Derive simplified_type from transaction_type
const deriveSimplifiedType = (transactionType: string): SimplifiedType => {
    if (transactionType === TransactionType.TRANSFER) {
        return TransactionType.TRANSFER;
    }
    return TransactionType.TRADE;
};

// Date utilities imported from utils/dateUtils

// Props for create mode
export interface ManualTransactionFormProps {
    onSuccess?: () => void;
}

export const ManualTransactionForm: React.FC<ManualTransactionFormProps> = ({
    onSuccess,
}) => {
    const queryClient = useQueryClient();
    const { assets, refetchAssets } = useAssets();
    const [formData, setFormData] = useState<FormData>(initialFormData);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [availableTags, setAvailableTags] = useState<Tag[]>([]);
    const [newTagKey, setNewTagKey] = useState('');
    const [newTagValue, setNewTagValue] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
    const [creatingAccount, setCreatingAccount] = useState(false);
    const [newAccountName, setNewAccountName] = useState('');
    const [newAccountType, setNewAccountType] = useState<'cex' | 'dex' | 'broker' | 'wallet' | 'bank' | 'investment'>('wallet');
    const [newAccountOwned, setNewAccountOwned] = useState(true);

    useEffect(() => {
        const initForm = async () => {
            // Fetch accounts and tags (assets come from useAssets hook)
            await fetchAccounts();
            await fetchTags();

            // Set default datetime to now
            const now = new Date();

            // Find EUR asset to set as default for price/fee quote
            const eurAsset = assets?.find((a: Asset) => a.symbol === 'EUR');
            const eurAssetId = eurAsset?.asset_id || null;

            setFormData(prev => ({
                ...prev,
                date_time: toDateTimeLocalString(now),
                price_quote_asset_id: eurAssetId,
                fee_quote_asset_id: eurAssetId,
            }));
        };
        initForm();
    }, [assets.length]);

    // Update from_account_id and to_account_id based on direction and account_id for transfers
    useEffect(() => {
        if (formData.simplified_type === 'transfer' && formData.account_id) {
            if (formData.direction === 'outflow') {
                // For outflow transfers: current account is the source (from_account)
                setFormData(prev => ({
                    ...prev,
                    from_account_id: formData.account_id,
                    // Keep existing to_account_id (counterparty) if it exists and is different from account_id
                    to_account_id: prev.to_account_id && prev.to_account_id !== formData.account_id ? prev.to_account_id : null
                }));
            } else {
                // For inflow transfers: current account is the destination (to_account)
                setFormData(prev => ({
                    ...prev,
                    to_account_id: formData.account_id,
                    // Keep existing from_account_id (counterparty) if it exists and is different from account_id
                    from_account_id: prev.from_account_id && prev.from_account_id !== formData.account_id ? prev.from_account_id : null
                }));
            }
        }
    }, [formData.account_id, formData.direction, formData.simplified_type]);

    // Auto-select taxable event for outflow trades with price in base currency (EUR)
    useEffect(() => {
        // Find EUR asset for comparison
        const eurAsset = assets.find(a => a.symbol === 'EUR');
        const eurAssetId = eurAsset?.asset_id;

        // Check conditions: trade + outflow + has price value + price_quote_asset is EUR
        const shouldBeChecked =
            formData.simplified_type === 'trade' &&
            formData.direction === 'outflow' &&
            formData.price &&
            parseFloat(formData.price) > 0 &&
            eurAssetId &&
            formData.price_quote_asset_id === eurAssetId;

        if (shouldBeChecked && !formData.disposal_taxable) {
            setFormData(prev => ({ ...prev, disposal_taxable: true }));
        }
    }, [formData.simplified_type, formData.direction, formData.price, formData.price_quote_asset_id, assets]);

    const fetchAccounts = async (): Promise<Account[] | null> => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
                return data;
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
        return null;
    };

    const fetchTags = async (): Promise<Tag[] | null> => {
        try {
            const response = await fetch(`${API_URL}/transactions/tags`);
            if (response.ok) {
                const data = await response.json();
                setAvailableTags(data);
                return data;
            }
        } catch (err) {
            console.error('Failed to fetch tags:', err);
        }
        return null;
    };

    const createAccount = async (name: string, accountType: 'cex' | 'dex' | 'broker' | 'wallet' | 'bank' | 'investment', owned: boolean): Promise<Account | null> => {
        try {
            const response = await fetch(`${API_URL}/accounts/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, account_type: accountType, owned }),
            });
            if (response.ok) {
                const data = await response.json();
                await fetchAccounts();
                return data;
            }
        } catch (err) {
            console.error('Failed to create account:', err);
        }
        return null;
    };

    const handleInputChange = (field: keyof FormData, value: string | number | boolean | null | Tag[]) => {
        setFormData(prev => {
            const updated = { ...prev, [field]: value };

            // Auto-derive transaction_type when simplified_type or direction changes
            if (field === 'simplified_type' || field === 'direction') {
                const simplifiedType = field === 'simplified_type' ? value as SimplifiedType : prev.simplified_type;
                const direction = field === 'direction' ? value as string : prev.direction;
                updated.transaction_type = deriveTransactionType(simplifiedType, direction);
            }

            // Auto-compute total when price or quantity changes
            if (field === 'price' || field === 'quantity') {
                const price = field === 'price' ? parseFloat(value as string) : parseFloat(prev.price);
                const quantity = field === 'quantity' ? parseFloat(value as string) : parseFloat(prev.quantity);
                if (!isNaN(price) && !isNaN(quantity) && price > 0 && quantity > 0) {
                    updated.total = (price * quantity).toFixed(2);
                }
            }

            return updated;
        });
        setError(null);
        setSuccess(null);
    };

    // Helper to check if tag exists in list
    const tagExists = (tags: Tag[], key: string, value: string): boolean => {
        return tags.some(t => t.key === key && t.value === value);
    };

    const validateForm = (): string | null => {
        if (!formData.date_time) return 'Date/Time is required';
        if (!formData.account_id) return 'Account is required';
        if (!formData.quantity || parseFloat(formData.quantity) <= 0) return 'Quantity must be greater than 0';
        if (!formData.asset_id) return 'Link to Asset is required';
        if (!formData.price_quote_asset_id) return 'Link to Price Quote Asset is required';
        // Fee quote asset is only required if there's actually a fee
        if (formData.fee && parseFloat(formData.fee) > 0 && !formData.fee_quote_asset_id) return 'Link to Fee Quote Asset is required when fee is specified';
        if (formData.simplified_type === 'transfer') {
            if (!formData.from_account_id || !formData.to_account_id) {
                return 'Both origin and destination accounts are required for transfers';
            }
            if (formData.from_account_id === formData.to_account_id) {
                return 'Origin and destination accounts must be different for transfers';
            }
        }
        return null;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const validationError = validateForm();
        if (validationError) {
            setError(validationError);
            return;
        }

        setLoading(true);
        setError(null);
        setSuccess(null);

        try {
            // Build payload
            const payload: any = {
                date_time: dateTimeLocalToISO(formData.date_time),
                direction: formData.direction,
                transaction_type: formData.transaction_type,
                quantity: parseFloat(formData.quantity),
                asset_id: formData.asset_id,
                price_quote_asset_id: formData.price_quote_asset_id,
                review_status: formData.review_status,
                include_fee: formData.include_fee,
                disposal_taxable: formData.disposal_taxable,
            };

            // Only include fee_quote_asset_id if it has a value (don't send null to avoid overwriting)
            if (formData.fee_quote_asset_id) {
                payload.fee_quote_asset_id = formData.fee_quote_asset_id;
            }

            // Add optional fields only if they have values
            if (formData.source) payload.source = formData.source;
            if (formData.account_id) payload.account_id = formData.account_id;
            if (formData.source_transaction_type) payload.source_transaction_type = formData.source_transaction_type;
            if (formData.source_transaction_id) payload.source_transaction_id = formData.source_transaction_id;
            if (formData.source_asset_symbol) payload.source_asset_symbol = formData.source_asset_symbol;
            if (formData.price) payload.price = parseFloat(formData.price);
            if (formData.source_price_quote_asset_symbol) payload.source_price_quote_asset_symbol = formData.source_price_quote_asset_symbol;
            if (formData.fee) payload.fee = parseFloat(formData.fee);
            if (formData.source_fee_quote_asset_symbol) payload.source_fee_quote_asset_symbol = formData.source_fee_quote_asset_symbol;
            if (formData.from_address) payload.source_from_account = formData.from_address;
            if (formData.to_address) payload.source_to_account = formData.to_address;
            if (formData.network) payload.network = formData.network;
            if (formData.network_transaction_id) payload.network_transaction_id = formData.network_transaction_id;
            if (formData.token_contract_address) payload.token_contract_address = formData.token_contract_address;
            if (formData.review_notes) payload.review_notes = formData.review_notes;
            if (formData.from_account_id) payload.from_account_id = formData.from_account_id;
            if (formData.to_account_id) payload.to_account_id = formData.to_account_id;

            // Convert tags from {key, value} format to [{key: value}] format
            if (formData.tags.length > 0) {
                payload.tags = formData.tags.map(tag => ({ [tag.key]: tag.value }));
            }

            const response = await fetch(`${API_URL}/transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to create transaction');
            }

            const result = await response.json();

            // API returns { transactions: [...], split: bool, message: str }
            const createdTransactions = result.transactions || [];
            setSuccess(`Transaction created successfully! ${result.message}`);
            // Add all created transactions (may be multiple if split into legs)
            setRecentTransactions(prev => [...createdTransactions, ...prev].slice(0, 5));

            // Trigger refresh of transactions in other components
            queryClient.invalidateQueries({ queryKey: ['transactions'] });

            // Reset form but keep date near current time and EUR defaults
            const now = new Date();
            const eurAsset = assets.find(a => a.symbol === 'EUR');
            const eurAssetId = eurAsset?.asset_id || null;
            setFormData({
                ...initialFormData,
                date_time: toDateTimeLocalString(now),
                price_quote_asset_id: eurAssetId,
                fee_quote_asset_id: eurAssetId,
            });

            onSuccess?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create transaction');
        } finally {
            setLoading(false);
        }
    };

    const handleClear = () => {
        const now = new Date();
        const eurAsset = assets.find(a => a.symbol === 'EUR');
        const eurAssetId = eurAsset?.asset_id || null;
        setFormData({
            ...initialFormData,
            date_time: toDateTimeLocalString(now),
            price_quote_asset_id: eurAssetId,
            fee_quote_asset_id: eurAssetId,
        });
        setError(null);
        setSuccess(null);
    };

    const [showAdvanced, setShowAdvanced] = useState(false);

    // Helper component for form labels
    const Label: React.FC<{ children: React.ReactNode; required?: boolean }> = ({ children, required }) => (
        <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={1} textTransform="uppercase" letterSpacing="wide">
            {children}{required && <Text as="span" color="red.500"> *</Text>}
        </Text>
    );

    return (
        <Box maxW="1200px" mx="auto">
            {/* Header */}
            <Box mb={6}>
                <Heading as="h2" size="lg" mb={2} color="gray.800">
                    Add Transaction
                </Heading>
                <Text color="gray.500" fontSize="sm">
                    Create a new transaction manually for OTC trades, airdrops, or other non-exchange activities.
                </Text>
            </Box>
            {/* Alerts */}
            {error && (
                <Box mb={4} p={4} bg="red.50" borderRadius="lg" borderLeft="4px solid" borderLeftColor="red.500">
                    <Text color="red.700" fontWeight="medium">❌ {error}</Text>
                </Box>
            )}
            {success && (
                <Box mb={4} p={4} bg="green.50" borderRadius="lg" borderLeft="4px solid" borderLeftColor="green.500">
                    <Text color="green.700" fontWeight="medium">✅ {success}</Text>
                </Box>
            )}

            <form onSubmit={handleSubmit}>
                <Flex direction="column" gap={5}>

                    {/* Section 1: Source & Timing */}
                    <Card.Root shadow="sm" borderRadius="xl" overflow="visible">
                        <Card.Header bg="gray.50" py={3} px={4} borderTopRadius="xl">
                            <Heading size="sm" color="gray.700">📍 Source & Timing</Heading>
                        </Card.Header>
                        <Card.Body p={4}>
                            <Grid templateColumns={{ base: "1fr", md: "repeat(5, 1fr)" }} gap={4}>
                                <GridItem>
                                    <Label required>Account</Label>
                                    <AccountSelector
                                        value={formData.account_id}
                                        onChange={(id) => handleInputChange('account_id', id)}
                                        accounts={accounts}
                                        onAccountCreated={fetchAccounts}
                                        placeholder="Select or create account..."
                                        rawAccountSource={formData.source}
                                        rawAccountLabel={undefined}
                                    />
                                    {/* Show account suggestions when source_account has a related account */}
                                    {formData.source_account && !formData.account_id && (() => {
                                        const suggestions = getAccountSuggestions(formData.source_account, accounts, 0.5, 3);
                                        return suggestions.length > 0 ? (
                                            <HStack gap={1} flexWrap="wrap" mt={1}>
                                                <Text fontSize="xs" color="gray.500">Suggestions:</Text>
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${formatConfidence(s.confidence)} match`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            size="xs"
                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                            cursor="pointer"
                                                            onClick={() => handleInputChange('account_id', s.item.id)}
                                                        >
                                                            {s.item.name}{s.confidence >= 0.9 && ' ✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </HStack>
                                        ) : null;
                                    })()}
                                </GridItem>
                                <GridItem>
                                    <Label required>Source</Label>
                                    <ComboSelect
                                        value={formData.source}
                                        onChange={val => handleInputChange('source', val)}
                                        options={SOURCE_OPTIONS}
                                        placeholder="Select source..."
                                        width="100%"
                                    />
                                </GridItem>
                                <GridItem>
                                    <Label required>Date & Time</Label>
                                    <Input
                                        type="datetime-local"
                                        value={formData.date_time}
                                        onChange={e => handleInputChange('date_time', e.target.value)}
                                        size="sm"
                                        borderRadius="md"
                                    />
                                </GridItem>
                                <GridItem>
                                    <Label>Source TX Type</Label>
                                    <Input
                                        placeholder="e.g., airdrop, otc"
                                        value={formData.source_transaction_type}
                                        onChange={e => handleInputChange('source_transaction_type', e.target.value)}
                                        size="sm"
                                        borderRadius="md"
                                    />
                                </GridItem>
                                <GridItem>
                                    <Label>Source TX ID</Label>
                                    <Input
                                        placeholder="External transaction ID"
                                        value={formData.source_transaction_id}
                                        onChange={e => handleInputChange('source_transaction_id', e.target.value)}
                                        size="sm"
                                        borderRadius="md"
                                    />
                                </GridItem>
                            </Grid>
                        </Card.Body>
                    </Card.Root>

                    {/* Section 2 + Tags: Transaction Details (75%) and Tags (25%) side by side */}
                    <Flex gap={4} direction={{ base: "column", lg: "row" }}>
                        {/* Section 2: Transaction Details - 75% */}
                        <Box flex="3">
                            <Card.Root shadow="sm" borderRadius="xl" overflow="visible" h="100%">
                                <Card.Header bg="blue.50" py={3} px={4} borderTopRadius="xl">
                                    <Heading size="sm" color="blue.700">💱 Transaction Details</Heading>
                                </Card.Header>
                                <Card.Body p={4}>
                                    <Grid templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }} gap={4} mb={4}>
                                        <GridItem>
                                            <Label required>Type</Label>
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field
                                                    value={formData.simplified_type}
                                                    onChange={e => handleInputChange('simplified_type', e.target.value)}
                                                    borderRadius="md"
                                                >
                                                    <option value="trade">💱 Trade (Buy/Sell/Swap)</option>
                                                    <option value="transfer">↔️ Transfer</option>
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                        </GridItem>
                                        <GridItem>
                                            <Label required>Direction</Label>
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field
                                                    value={formData.direction}
                                                    onChange={e => handleInputChange('direction', e.target.value)}
                                                    borderRadius="md"
                                                >
                                                    <option value="inflow">↓ Inflow (Receive)</option>
                                                    <option value="outflow">↑ Outflow (Send)</option>
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                            <Text fontSize="xs" color="gray.500" mt={1}>
                                                {formData.simplified_type === 'trade'
                                                    ? (formData.direction === 'inflow' ? '→ Acquisition' : '→ Disposal')
                                                    : (formData.direction === 'inflow' ? '→ Transfer In' : '→ Transfer Out')
                                                }
                                            </Text>
                                        </GridItem>
                                        <GridItem>
                                            <Label>Review Status</Label>
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field
                                                    value={formData.review_status}
                                                    onChange={e => handleInputChange('review_status', e.target.value)}
                                                    borderRadius="md"
                                                >
                                                    <option value="pending">🟡 Pending</option>
                                                    <option value="valid">🟢 Valid</option>
                                                    <option value="invalid">🔴 Invalid</option>
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                        </GridItem>
                                    </Grid>

                                    {/* Transfer Destination Account - only show for transfers */}
                                    {formData.simplified_type === 'transfer' && (
                                        <Box bg="purple.50" p={4} borderRadius="lg" mb={4}>
                                            <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={4} alignItems="end">
                                                <GridItem>
                                                    <Label required>
                                                        {formData.direction === 'outflow' ? 'Destination Account' : 'Origin Account'}
                                                    </Label>
                                                    {!creatingAccount ? (
                                                        <Flex gap={2}>
                                                            <NativeSelect.Root size="sm" flex={1}>
                                                                <NativeSelect.Field
                                                                    value={formData.direction === 'outflow' ? (formData.to_account_id || '') : (formData.from_account_id || '')}
                                                                    onChange={e => {
                                                                        const selectedId = e.target.value ? parseInt(e.target.value) : null;
                                                                        if (formData.direction === 'outflow') {
                                                                            handleInputChange('to_account_id', selectedId);
                                                                        } else {
                                                                            handleInputChange('from_account_id', selectedId);
                                                                        }
                                                                    }}
                                                                    borderRadius="md"
                                                                >
                                                                    <option value="">Select account...</option>
                                                                    {accounts.map(acc => (
                                                                        <option key={acc.id} value={acc.id}>
                                                                            {acc.name} ({acc.account_type}) {acc.owned ? '✓ Owned' : ''}
                                                                        </option>
                                                                    ))}
                                                                </NativeSelect.Field>
                                                            </NativeSelect.Root>
                                                            <Button size="sm" variant="outline" onClick={() => setCreatingAccount(true)}>
                                                                + New
                                                            </Button>
                                                        </Flex>
                                                    ) : (
                                                        <Flex direction="column" gap={2}>
                                                            <Input
                                                                placeholder="New account name"
                                                                value={newAccountName}
                                                                onChange={e => setNewAccountName(e.target.value)}
                                                                size="sm"
                                                                borderRadius="md"
                                                            />
                                                            <Flex gap={2}>
                                                                <NativeSelect.Root size="sm" flex={1}>
                                                                    <NativeSelect.Field
                                                                        value={newAccountType}
                                                                        onChange={e => setNewAccountType(e.target.value as 'cex' | 'dex' | 'broker' | 'wallet' | 'bank' | 'investment')}
                                                                        borderRadius="md"
                                                                    >
                                                                        <option value="wallet">Wallet</option>
                                                                        <option value="cex">CEX</option>
                                                                        <option value="dex">DEX</option>
                                                                        <option value="broker">Broker</option>
                                                                        <option value="bank">Bank</option>
                                                                        <option value="investment">Investment</option>
                                                                    </NativeSelect.Field>
                                                                </NativeSelect.Root>
                                                                <Checkbox.Root
                                                                    checked={newAccountOwned}
                                                                    onCheckedChange={(e) => setNewAccountOwned(!!e.checked)}
                                                                    size="sm"
                                                                >
                                                                    <Checkbox.HiddenInput />
                                                                    <Checkbox.Control />
                                                                    <Checkbox.Label fontSize="xs">Owned</Checkbox.Label>
                                                                </Checkbox.Root>
                                                            </Flex>
                                                            <Flex gap={2}>
                                                                <Button
                                                                    size="sm"
                                                                    colorPalette="green"
                                                                    onClick={async () => {
                                                                        if (newAccountName) {
                                                                            const created = await createAccount(newAccountName, newAccountType, newAccountOwned);
                                                                            if (created) {
                                                                                if (formData.direction === 'outflow') {
                                                                                    handleInputChange('to_account_id', created.id);
                                                                                } else {
                                                                                    handleInputChange('from_account_id', created.id);
                                                                                }
                                                                                setNewAccountName('');
                                                                                setCreatingAccount(false);
                                                                            }
                                                                        }
                                                                    }}
                                                                >
                                                                    Create
                                                                </Button>
                                                                <Button size="sm" variant="ghost" onClick={() => {
                                                                    setCreatingAccount(false);
                                                                    setNewAccountName('');
                                                                }}>
                                                                    Cancel
                                                                </Button>
                                                            </Flex>
                                                        </Flex>
                                                    )}
                                                </GridItem>
                                                <GridItem>
                                                    {/* Internal transfer indicator */}
                                                    {(() => {
                                                        const mainAcc = accounts.find(a => a.id === formData.account_id);
                                                        const counterpartyId = formData.direction === 'outflow' ? formData.to_account_id : formData.from_account_id;
                                                        const counterpartyAcc = accounts.find(a => a.id === counterpartyId);
                                                        const isInternal = mainAcc?.owned && counterpartyAcc?.owned;
                                                        const isExternal = (mainAcc?.owned && !counterpartyAcc?.owned) || (!mainAcc?.owned && counterpartyAcc?.owned);

                                                        if (counterpartyId && formData.account_id) {
                                                            return (
                                                                <Box p={3} borderRadius="md" bg={isInternal ? 'green.100' : isExternal ? 'orange.100' : 'gray.100'}>
                                                                    {isInternal ? (
                                                                        <Flex align="center" gap={2}>
                                                                            <Text fontSize="lg">🏠</Text>
                                                                            <Box>
                                                                                <Text fontSize="sm" fontWeight="bold" color="green.700">Internal Transfer</Text>
                                                                                <Text fontSize="xs" color="green.600">Both accounts are owned - no taxable event</Text>
                                                                            </Box>
                                                                        </Flex>
                                                                    ) : isExternal ? (
                                                                        <Flex align="center" gap={2}>
                                                                            <Text fontSize="lg">🌐</Text>
                                                                            <Box>
                                                                                <Text fontSize="sm" fontWeight="bold" color="orange.700">External Transfer</Text>
                                                                                <Text fontSize="xs" color="orange.600">
                                                                                    {!counterpartyAcc?.owned ? 'To external party' : 'From external party'}
                                                                                </Text>
                                                                            </Box>
                                                                        </Flex>
                                                                    ) : (
                                                                        <Text fontSize="xs" color="gray.500">Select both accounts to see transfer type</Text>
                                                                    )}
                                                                </Box>
                                                            );
                                                        }
                                                        return null;
                                                    })()}
                                                </GridItem>
                                            </Grid>
                                        </Box>
                                    )}

                                    {/* Asset Row */}
                                    <Box bg="gray.50" p={4} borderRadius="lg" mb={4}>
                                        <Grid templateColumns={{ base: "1fr", md: "2fr 1fr 1fr" }} gap={4} alignItems="end">
                                            <GridItem>
                                                <Label required>Asset</Label>
                                                <AssetSelector
                                                    value={formData.asset_id}
                                                    onChange={(id) => handleInputChange('asset_id', id)}
                                                    assets={assets}
                                                    onAssetCreated={refetchAssets}
                                                    defaultSymbol=""
                                                    placeholder="Select or create asset..."
                                                    rawAssetSource="manual"
                                                    rawAssetSymbol={formData.source_asset_symbol}
                                                />
                                                {/* Show asset suggestions when source symbol is provided */}
                                                {formData.source_asset_symbol && !formData.asset_id && (() => {
                                                    const suggestions = getAssetSuggestions(formData.source_asset_symbol, assets, 0.5, 3);
                                                    return suggestions.length > 0 ? (
                                                        <HStack gap={1} flexWrap="wrap" mt={1}>
                                                            <Text fontSize="xs" color="gray.500">Suggestions:</Text>
                                                            {suggestions.map((s, idx) => (
                                                                <Tooltip
                                                                    key={idx}
                                                                    content={`${formatConfidence(s.confidence)} match`}
                                                                    openDelay={100}
                                                                >
                                                                    <Badge
                                                                        size="xs"
                                                                        colorPalette={getConfidenceColor(s.confidence)}
                                                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                        cursor="pointer"
                                                                        onClick={() => handleInputChange('asset_id', s.item.asset_id!)}
                                                                    >
                                                                        {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                    </Badge>
                                                                </Tooltip>
                                                            ))}
                                                        </HStack>
                                                    ) : null;
                                                })()}
                                            </GridItem>
                                            <GridItem>
                                                <Label>Source Symbol</Label>
                                                <Input
                                                    placeholder="Original symbol"
                                                    value={formData.source_asset_symbol}
                                                    onChange={e => handleInputChange('source_asset_symbol', e.target.value.toUpperCase())}
                                                    size="sm"
                                                    borderRadius="md"
                                                />
                                            </GridItem>
                                            <GridItem>
                                                <Label required>Quantity</Label>
                                                <Input
                                                    type="number"
                                                    step="any"
                                                    placeholder="0.00"
                                                    value={formData.quantity}
                                                    onChange={e => handleInputChange('quantity', e.target.value)}
                                                    size="sm"
                                                    borderRadius="md"
                                                    fontWeight="semibold"
                                                />
                                            </GridItem>
                                        </Grid>
                                    </Box>

                                </Card.Body>
                            </Card.Root>
                        </Box>

                        {/* Section 2.5: Tags - 25% */}
                        <Box flex="1">
                            <Card.Root shadow="sm" borderRadius="xl" overflow="visible" h="100%">
                                <Card.Header bg="purple.50" py={3} px={4} borderTopRadius="xl">
                                    <Heading size="sm" color="purple.700">🏷️ Tags</Heading>
                                </Card.Header>
                                <Card.Body p={4}>
                                    <Text fontSize="xs" color="gray.500" mb={3}>
                                        Add key-value tags to categorize this transaction
                                    </Text>

                                    {/* Selected tags */}
                                    {formData.tags.length > 0 && (
                                        <Flex gap={2} wrap="wrap" mb={3}>
                                            {formData.tags.map((tag, idx) => (
                                                <Badge
                                                    key={idx}
                                                    colorPalette="purple"
                                                    variant="solid"
                                                    cursor="pointer"
                                                    onClick={() => handleInputChange('tags', formData.tags.filter((_, i) => i !== idx))}
                                                    title="Click to remove"
                                                >
                                                    {tag.key}: {tag.value} ✕
                                                </Badge>
                                            ))}
                                        </Flex>
                                    )}

                                    {/* Add new tag */}
                                    <Flex gap={2} mb={3}>
                                        <Input
                                            placeholder="Key (e.g., category)"
                                            value={newTagKey}
                                            onChange={e => setNewTagKey(e.target.value)}
                                            size="sm"
                                            borderRadius="md"
                                            flex={1}
                                        />
                                        <Input
                                            placeholder="Value (e.g., airdrop)"
                                            value={newTagValue}
                                            onChange={e => setNewTagValue(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newTagKey.trim() && newTagValue.trim()) {
                                                    e.preventDefault();
                                                    const key = newTagKey.trim().toLowerCase();
                                                    const value = newTagValue.trim().toLowerCase();
                                                    if (!tagExists(formData.tags, key, value)) {
                                                        const newTag: Tag = { key, value };
                                                        handleInputChange('tags', [...formData.tags, newTag]);
                                                        if (!tagExists(availableTags, key, value)) {
                                                            setAvailableTags(prev => [...prev, newTag]);
                                                        }
                                                    }
                                                    setNewTagKey('');
                                                    setNewTagValue('');
                                                }
                                            }}
                                            size="sm"
                                            borderRadius="md"
                                            flex={1}
                                        />
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                if (newTagKey.trim() && newTagValue.trim()) {
                                                    const key = newTagKey.trim().toLowerCase();
                                                    const value = newTagValue.trim().toLowerCase();
                                                    if (!tagExists(formData.tags, key, value)) {
                                                        const newTag: Tag = { key, value };
                                                        handleInputChange('tags', [...formData.tags, newTag]);
                                                        if (!tagExists(availableTags, key, value)) {
                                                            setAvailableTags(prev => [...prev, newTag]);
                                                        }
                                                    }
                                                    setNewTagKey('');
                                                    setNewTagValue('');
                                                }
                                            }}
                                        >
                                            Add
                                        </Button>
                                    </Flex>

                                    {/* Existing tags suggestions */}
                                    {availableTags.length > 0 && (
                                        <Box>
                                            <Text fontSize="xs" color="gray.500" mb={2}>Click to add existing tags:</Text>
                                            <Flex gap={2} wrap="wrap">
                                                {availableTags
                                                    .filter(tag => !tagExists(formData.tags, tag.key, tag.value))
                                                    .slice(0, 15)
                                                    .map((tag, idx) => (
                                                        <Badge
                                                            key={idx}
                                                            colorPalette="gray"
                                                            variant="subtle"
                                                            cursor="pointer"
                                                            onClick={() => handleInputChange('tags', [...formData.tags, tag])}
                                                            _hover={{ bg: 'purple.100' }}
                                                        >
                                                            + {tag.key}: {tag.value}
                                                        </Badge>
                                                    ))}
                                            </Flex>
                                        </Box>
                                    )}
                                </Card.Body>
                            </Card.Root>
                        </Box>
                    </Flex>

                    {/* Section 3: Pricing */}
                    <Card.Root shadow="sm" borderRadius="xl" overflow="visible">
                        <Card.Header bg="green.50" py={3} px={4} borderTopRadius="xl">
                            <Heading size="sm" color="green.700">💰 Pricing & Fees</Heading>
                        </Card.Header>
                        <Card.Body p={4}>
                            <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={6}>
                                {/* Price Section */}
                                <Box>
                                    <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={3} textTransform="uppercase">Price</Text>
                                    <Grid templateColumns="1fr 1fr" gap={3}>
                                        <GridItem>
                                            <Label>Unit Price</Label>
                                            <Input
                                                type="number"
                                                step="any"
                                                placeholder="0.00"
                                                value={formData.price}
                                                onChange={e => handleInputChange('price', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                            />
                                        </GridItem>
                                        <GridItem>
                                            <Label required>Quote Asset</Label>
                                            <AssetSelector
                                                value={formData.price_quote_asset_id}
                                                onChange={(id) => handleInputChange('price_quote_asset_id', id)}
                                                assets={assets}
                                                onAssetCreated={refetchAssets}
                                                defaultSymbol=""
                                                placeholder="e.g., EUR"
                                                rawAssetSource="manual"
                                                rawAssetSymbol={formData.source_price_quote_asset_symbol}
                                            />
                                            {/* Show suggestions when source symbol is provided */}
                                            {formData.source_price_quote_asset_symbol && !formData.price_quote_asset_id && (() => {
                                                const suggestions = getAssetSuggestions(formData.source_price_quote_asset_symbol, assets, 0.5, 3);
                                                return suggestions.length > 0 ? (
                                                    <HStack gap={1} flexWrap="wrap" mt={1}>
                                                        <Text fontSize="xs" color="gray.500">Suggestions:</Text>
                                                        {suggestions.map((s, idx) => (
                                                            <Tooltip
                                                                key={idx}
                                                                content={`${formatConfidence(s.confidence)} match`}
                                                                openDelay={100}
                                                            >
                                                                <Badge
                                                                    size="xs"
                                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                    cursor="pointer"
                                                                    onClick={() => handleInputChange('price_quote_asset_id', s.item.asset_id!)}
                                                                >
                                                                    {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                </Badge>
                                                            </Tooltip>
                                                        ))}
                                                    </HStack>
                                                ) : null;
                                            })()}
                                        </GridItem>
                                    </Grid>
                                    <Box mt={3}>
                                        <Label>Total Value</Label>
                                        <Input
                                            type="number"
                                            step="any"
                                            placeholder="Auto: Price × Quantity"
                                            value={formData.total}
                                            onChange={e => handleInputChange('total', e.target.value)}
                                            size="sm"
                                            borderRadius="md"
                                            bg="gray.50"
                                        />
                                    </Box>
                                </Box>

                                {/* Fee Section */}
                                <Box>
                                    <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={3} textTransform="uppercase">Fee</Text>
                                    <Grid templateColumns="1fr 1fr" gap={3}>
                                        <GridItem>
                                            <Label>Fee Amount</Label>
                                            <Input
                                                type="number"
                                                step="any"
                                                placeholder="0.00"
                                                value={formData.fee}
                                                onChange={e => handleInputChange('fee', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                            />
                                        </GridItem>
                                        <GridItem>
                                            <Label required>Fee Quote Asset</Label>
                                            <AssetSelector
                                                value={formData.fee_quote_asset_id}
                                                onChange={(id) => handleInputChange('fee_quote_asset_id', id)}
                                                assets={assets}
                                                onAssetCreated={refetchAssets}
                                                defaultSymbol=""
                                                placeholder="e.g., EUR"
                                                rawAssetSource="manual"
                                                rawAssetSymbol={formData.source_fee_quote_asset_symbol}
                                            />
                                            {/* Show suggestions when source symbol is provided */}
                                            {formData.source_fee_quote_asset_symbol && !formData.fee_quote_asset_id && (() => {
                                                const suggestions = getAssetSuggestions(formData.source_fee_quote_asset_symbol, assets, 0.5, 3);
                                                return suggestions.length > 0 ? (
                                                    <HStack gap={1} flexWrap="wrap" mt={1}>
                                                        <Text fontSize="xs" color="gray.500">Suggestions:</Text>
                                                        {suggestions.map((s, idx) => (
                                                            <Tooltip
                                                                key={idx}
                                                                content={`${formatConfidence(s.confidence)} match`}
                                                                openDelay={100}
                                                            >
                                                                <Badge
                                                                    size="xs"
                                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                    cursor="pointer"
                                                                    onClick={() => handleInputChange('fee_quote_asset_id', s.item.asset_id!)}
                                                                >
                                                                    {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                </Badge>
                                                            </Tooltip>
                                                        ))}
                                                    </HStack>
                                                ) : null;
                                            })()}
                                        </GridItem>
                                    </Grid>
                                </Box>
                            </Grid>

                            {/* P&L Options */}
                            <Flex gap={6} mt={4} pt={4} borderTop="1px" borderColor="gray.200">
                                <Checkbox.Root
                                    checked={formData.include_fee}
                                    onCheckedChange={(e) => handleInputChange('include_fee', !!e.checked)}
                                >
                                    <Checkbox.HiddenInput />
                                    <Checkbox.Control />
                                    <Checkbox.Label fontSize="sm">Include Fee in P&L</Checkbox.Label>
                                </Checkbox.Root>
                                <Checkbox.Root
                                    checked={formData.disposal_taxable}
                                    onCheckedChange={(e) => handleInputChange('disposal_taxable', !!e.checked)}
                                >
                                    <Checkbox.HiddenInput />
                                    <Checkbox.Control />
                                    <Checkbox.Label fontSize="sm">Taxable Event</Checkbox.Label>
                                </Checkbox.Root>
                            </Flex>
                        </Card.Body>
                    </Card.Root>

                    {/* Section 4: Advanced (Collapsible) */}
                    <Card.Root shadow="sm" borderRadius="xl" overflow="visible">
                        <Collapsible.Root open={showAdvanced} onOpenChange={(e) => setShowAdvanced(e.open)}>
                            <Collapsible.Trigger asChild>
                                <Card.Header
                                    bg="purple.50"
                                    py={3}
                                    px={4}
                                    borderTopRadius="xl"
                                    cursor="pointer"
                                    _hover={{ bg: "purple.100" }}
                                    transition="background 0.2s"
                                >
                                    <Flex justify="space-between" align="center">
                                        <Heading size="sm" color="purple.700">🔗 Network & Advanced</Heading>
                                        <Text color="purple.600" fontSize="sm">
                                            {showAdvanced ? '▲ Hide' : '▼ Show'}
                                        </Text>
                                    </Flex>
                                </Card.Header>
                            </Collapsible.Trigger>
                            <Collapsible.Content>
                                <Card.Body p={4}>
                                    <Grid templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }} gap={4} mb={4}>
                                        <GridItem>
                                            <Label>Network</Label>
                                            <Input
                                                placeholder="ethereum, base, solana..."
                                                value={formData.network}
                                                onChange={e => handleInputChange('network', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                            />
                                        </GridItem>
                                        <GridItem>
                                            <Label>From Address</Label>
                                            <Input
                                                placeholder="0x..."
                                                value={formData.from_address}
                                                onChange={e => handleInputChange('from_address', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                                fontFamily="mono"
                                                fontSize="xs"
                                            />
                                        </GridItem>
                                        <GridItem>
                                            <Label>To Address</Label>
                                            <Input
                                                placeholder="0x..."
                                                value={formData.to_address}
                                                onChange={e => handleInputChange('to_address', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                                fontFamily="mono"
                                                fontSize="xs"
                                            />
                                        </GridItem>
                                    </Grid>
                                    <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={4}>
                                        <GridItem>
                                            <Label>Transaction Hash</Label>
                                            <Input
                                                placeholder="0x..."
                                                value={formData.network_transaction_id}
                                                onChange={e => handleInputChange('network_transaction_id', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                                fontFamily="mono"
                                                fontSize="xs"
                                            />
                                        </GridItem>
                                        <GridItem>
                                            <Label>Token Contract</Label>
                                            <Input
                                                placeholder="0x..."
                                                value={formData.token_contract_address}
                                                onChange={e => handleInputChange('token_contract_address', e.target.value)}
                                                size="sm"
                                                borderRadius="md"
                                                fontFamily="mono"
                                                fontSize="xs"
                                            />
                                        </GridItem>
                                    </Grid>
                                    <Box mt={4}>
                                        <Label>Review Notes</Label>
                                        <Input
                                            placeholder="Add any notes about this transaction..."
                                            value={formData.review_notes}
                                            onChange={e => handleInputChange('review_notes', e.target.value)}
                                            size="sm"
                                            borderRadius="md"
                                        />
                                    </Box>
                                </Card.Body>
                            </Collapsible.Content>
                        </Collapsible.Root>
                    </Card.Root>

                </Flex>

                {/* Sticky Action Bar */}
                <Box
                    position="sticky"
                    bottom={0}
                    bg="white"
                    py={4}
                    mt={6}
                    borderTop="1px solid"
                    borderColor="gray.200"
                    zIndex={10}
                >
                    <Flex gap={3} justify="flex-end">
                        <Button
                            variant="ghost"
                            onClick={handleClear}
                            disabled={loading}
                            size="lg"
                        >
                            Clear
                        </Button>
                        <Button
                            type="submit"
                            colorPalette="blue"
                            disabled={loading}
                            size="lg"
                            px={8}
                        >
                            {loading ? <Spinner size="sm" mr={2} /> : null}
                            {loading ? 'Creating...' : '➕ Create Transaction'}
                        </Button>
                    </Flex>
                </Box>
            </form>

            {/* Recent Transactions */}
            {recentTransactions.length > 0 && (
                <Card.Root mt={8} shadow="sm" borderRadius="xl">
                    <Card.Header bg="gray.50" py={3} px={4}>
                        <Heading size="sm" color="gray.700">✨ Recently Created</Heading>
                    </Card.Header>
                    <Card.Body p={4}>
                        <Flex direction="column" gap={2}>
                            {recentTransactions.map(tx => (
                                <Flex
                                    key={tx.id}
                                    align="center"
                                    gap={3}
                                    p={3}
                                    bg="gray.50"
                                    borderRadius="lg"
                                    fontSize="sm"
                                    _hover={{ bg: "gray.100" }}
                                    transition="background 0.2s"
                                >
                                    <Badge colorPalette="purple" variant="solid">#{tx.id}</Badge>
                                    <Badge
                                        colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                        variant="subtle"
                                    >
                                        {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'} {tx.direction}
                                    </Badge>
                                    <Text fontWeight="bold">{tx.quantity}</Text>
                                    <Text color="gray.600">{tx.linked_asset_symbol || tx.source_asset_symbol || 'Unknown'}</Text>
                                    <Badge variant="outline">{tx.transaction_type}</Badge>
                                    <Text color="gray.400" fontSize="xs" ml="auto">
                                        {formatDateTimeLocale(tx.date_time)}
                                    </Text>
                                </Flex>
                            ))}
                        </Flex>
                    </Card.Body>
                </Card.Root>
            )}
        </Box>
    );
};
