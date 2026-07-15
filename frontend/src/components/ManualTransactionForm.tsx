import { Badge, Button, Input, Spinner, type BadgeColorScheme } from './ui/primitives';
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
type SimplifiedType = typeof TransactionType.TRADE | typeof TransactionType.TRANSFER | typeof TransactionType.MARGIN | typeof TransactionType.COST;

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
    taxability_status: string;
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
    taxability_status: 'unknown',
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
    return simplifiedType;
};

// Derive simplified_type from transaction_type
const deriveSimplifiedType = (transactionType: string): SimplifiedType => {
    if (transactionType === TransactionType.TRANSFER) {
        return TransactionType.TRANSFER;
    }
    if (transactionType === TransactionType.MARGIN) {
        return TransactionType.MARGIN;
    }
    if (transactionType === TransactionType.COST) {
        return TransactionType.COST;
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

        if (shouldBeChecked && formData.taxability_status === 'unknown') {
            setFormData(prev => ({ ...prev, taxability_status: 'taxable' }));
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

            // Auto-compute price when total changes (reverse: price = total / quantity)
            if (field === 'total') {
                const total = parseFloat(value as string);
                const quantity = parseFloat(prev.quantity);
                if (!isNaN(total) && !isNaN(quantity) && total > 0 && quantity > 0) {
                    updated.price = (total / quantity).toFixed(8);
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
                taxability_status: formData.taxability_status,
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
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {children}{required && <span className="text-red-500"> *</span>}
        </p>
    );

    return (
        <div className="text-xs">
            {/* Header */}
            <div className="mb-4">
                <h2 className="mb-1 text-sm font-semibold text-slate-800">
                    Add Transaction
                </h2>
                <p className="text-xs text-slate-500">
                    Create a new transaction manually for OTC trades, airdrops, or other non-exchange activities.
                </p>
            </div>
            {/* Alerts */}
            {error && (
                <div className="mb-4 border-l-4 border-l-red-500 bg-red-50 p-4">
                    <p className="font-medium text-red-700">❌ {error}</p>
                </div>
            )}
            {success && (
                <div className="mb-4 border-l-4 border-l-green-500 bg-green-50 p-4">
                    <p className="font-medium text-green-700">✅ {success}</p>
                </div>
            )}

            <form onSubmit={handleSubmit}>
                <div className="flex flex-col gap-5">

                    {/* Section 1: Source & Timing */}
                    <div className="overflow-visible border border-slate-200 bg-white shadow-sm">
                        <div className="bg-slate-50 px-3 py-2">
                            <h3 className="text-xs font-semibold text-slate-700">📍 Source & Timing</h3>
                        </div>
                        <div className="p-3">
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
                                <div>
                                    <Label required>Account</Label>
                                    <AccountSelector
                                        value={formData.account_id}
                                        onChange={(id) => handleInputChange('account_id', id)}
                                        accounts={accounts}
                                        onAccountCreated={fetchAccounts}
                                        placeholder="Select or create account..."
                                        rawAccountSource={formData.source}
                                        rawAccountLabel={undefined}
                                        size="xs"
                                    />
                                    {/* Show account suggestions when source_account has a related account */}
                                    {formData.source_account && !formData.account_id && (() => {
                                        const suggestions = getAccountSuggestions(formData.source_account, accounts, 0.5, 3);
                                        return suggestions.length > 0 ? (
                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                <span className="text-xs text-slate-500">Suggestions:</span>
                                                {suggestions.map((s, idx) => (
                                                    <Tooltip
                                                        key={idx}
                                                        content={`${formatConfidence(s.confidence)} match`}
                                                        openDelay={100}
                                                    >
                                                        <Badge
                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                            className="cursor-pointer"
                                                            onClick={() => handleInputChange('account_id', s.item.id)}
                                                        >
                                                            {s.item.name}{s.confidence >= 0.9 && ' ✓'}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        ) : null;
                                    })()}
                                </div>
                                <div>
                                    <Label required>Source</Label>
                                    <ComboSelect
                                        value={formData.source}
                                        onChange={val => handleInputChange('source', val)}
                                        options={SOURCE_OPTIONS}
                                        placeholder="Select source..."
                                        width="100%"
                                        size="xs"
                                    />
                                </div>
                                <div>
                                    <Label required>Date & Time</Label>
                                    <Input
                                        type="datetime-local"
                                        value={formData.date_time}
                                        onChange={e => handleInputChange('date_time', e.target.value)}
                                        className="h-7 text-xs"
                                    />
                                </div>
                                <div>
                                    <Label>Source TX Type</Label>
                                    <Input
                                        placeholder="e.g., airdrop, otc"
                                        value={formData.source_transaction_type}
                                        onChange={e => handleInputChange('source_transaction_type', e.target.value)}
                                        className="h-7 text-xs"
                                    />
                                </div>
                                <div>
                                    <Label>Source TX ID</Label>
                                    <Input
                                        placeholder="External transaction ID"
                                        value={formData.source_transaction_id}
                                        onChange={e => handleInputChange('source_transaction_id', e.target.value)}
                                        className="h-7 text-xs"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>


                    {/* Section 2 + Pricing: Transaction Details (1/2) and Pricing & Fees (1/2) side by side */}
                    <div className="flex flex-col gap-4 lg:flex-row">
                        {/* Section 2: Transaction Details - 50% */}
                        <div className="flex-1">
                            <div className="h-full overflow-visible border border-slate-200 bg-white shadow-sm">
                                <div className="bg-blue-50 px-3 py-2">
                                    <h3 className="text-xs font-semibold text-blue-700">💱 Transaction Details</h3>
                                </div>
                                <div className="p-3">
                                    <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                                        <div>
                                            <Label required>Type</Label>
                                            <select
                                                title="Type"
                                                value={formData.simplified_type}
                                                onChange={e => handleInputChange('simplified_type', e.target.value)}
                                                className="h-7 w-full border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            >
                                                <option value="trade">💱 Trade (Buy/Sell/Swap)</option>
                                                <option value="transfer">↔️ Transfer</option>
                                                <option value="margin">📈 Margin (Derivative)</option>
                                                <option value="cost">💸 Cost (Fee-only)</option>
                                            </select>
                                        </div>
                                        <div>
                                            <Label required>Direction</Label>
                                            <select
                                                title="Direction"
                                                value={formData.direction}
                                                onChange={e => handleInputChange('direction', e.target.value)}
                                                className="h-7 w-full border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            >
                                                <option value="inflow">↓ Inflow (Receive)</option>
                                                <option value="outflow">↑ Outflow (Send)</option>
                                            </select>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {formData.simplified_type === 'trade'
                                                    ? (formData.direction === 'inflow' ? '→ Acquisition' : '→ Disposal')
                                                    : (formData.direction === 'inflow' ? '→ Transfer In' : '→ Transfer Out')
                                                }
                                            </p>
                                        </div>
                                        <div>
                                            <Label>Review Status</Label>
                                            <select
                                                title="Review Status"
                                                value={formData.review_status}
                                                onChange={e => handleInputChange('review_status', e.target.value)}
                                                className="h-7 w-full border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            >
                                                <option value="pending">🟡 Pending</option>
                                                <option value="valid">🟢 Valid</option>
                                                <option value="invalid">🔴 Invalid</option>
                                            </select>
                                        </div>
                                    </div>

                                    {/* Transfer Destination Account - only show for transfers */}
                                    {formData.simplified_type === 'transfer' && (
                                        <div className="mb-4 bg-purple-50 p-4">
                                            <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-2">
                                                <div>
                                                    <Label required>
                                                        {formData.direction === 'outflow' ? 'Destination Account' : 'Origin Account'}
                                                    </Label>
                                                    {!creatingAccount ? (
                                                        <div className="flex gap-2">
                                                            <select
                                                                title="Account"
                                                                value={formData.direction === 'outflow' ? (formData.to_account_id || '') : (formData.from_account_id || '')}
                                                                onChange={e => {
                                                                    const selectedId = e.target.value ? parseInt(e.target.value) : null;
                                                                    if (formData.direction === 'outflow') {
                                                                        handleInputChange('to_account_id', selectedId);
                                                                    } else {
                                                                        handleInputChange('from_account_id', selectedId);
                                                                    }
                                                                }}
                                                                className="h-7 flex-1 border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                            >
                                                                <option value="">Select account...</option>
                                                                {accounts.map(acc => (
                                                                    <option key={acc.id} value={acc.id}>
                                                                        {acc.name} ({acc.account_type}) {acc.owned ? '✓ Owned' : ''}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                            <Button size="sm" variant="outline" onClick={() => setCreatingAccount(true)} className="h-7">
                                                                + New
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex flex-col gap-2">
                                                            <Input
                                                                placeholder="New account name"
                                                                value={newAccountName}
                                                                onChange={e => setNewAccountName(e.target.value)}
                                                                className="h-7 text-xs"
                                                            />
                                                            <div className="flex gap-2">
                                                                <select
                                                                    title="Account Type"
                                                                    value={newAccountType}
                                                                    onChange={e => setNewAccountType(e.target.value as 'cex' | 'dex' | 'broker' | 'wallet' | 'bank' | 'investment')}
                                                                    className="h-7 flex-1 border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                                >
                                                                    <option value="wallet">Wallet</option>
                                                                    <option value="cex">CEX</option>
                                                                    <option value="dex">DEX</option>
                                                                    <option value="broker">Broker</option>
                                                                    <option value="bank">Bank</option>
                                                                    <option value="investment">Investment</option>
                                                                </select>
                                                                <label className="flex items-center gap-1 text-xs">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={newAccountOwned}
                                                                        onChange={(e) => setNewAccountOwned(e.target.checked)}
                                                                        className="h-4 w-4 cursor-pointer accent-blue-500"
                                                                    />
                                                                    Owned
                                                                </label>
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <Button
                                                                    size="sm"
                                                                    colorScheme="green"
                                                                    className="h-7"
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
                                                                <Button size="sm" variant="ghost" className="h-7" onClick={() => {
                                                                    setCreatingAccount(false);
                                                                    setNewAccountName('');
                                                                }}>
                                                                    Cancel
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div>
                                                    {/* Internal transfer indicator */}
                                                    {(() => {
                                                        const mainAcc = accounts.find(a => a.id === formData.account_id);
                                                        const counterpartyId = formData.direction === 'outflow' ? formData.to_account_id : formData.from_account_id;
                                                        const counterpartyAcc = accounts.find(a => a.id === counterpartyId);
                                                        const isInternal = mainAcc?.owned && counterpartyAcc?.owned;
                                                        const isExternal = (mainAcc?.owned && !counterpartyAcc?.owned) || (!mainAcc?.owned && counterpartyAcc?.owned);

                                                        if (counterpartyId && formData.account_id) {
                                                            return (
                                                                <div className={`p-3 ${isInternal ? 'bg-green-100' : isExternal ? 'bg-orange-100' : 'bg-slate-100'}`}>
                                                                    {isInternal ? (
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-lg">🏠</span>
                                                                            <div>
                                                                                <p className="text-xs font-bold text-green-700">Internal Transfer</p>
                                                                                <p className="text-xs text-green-600">Both accounts are owned - no taxable event</p>
                                                                            </div>
                                                                        </div>
                                                                    ) : isExternal ? (
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-lg">🌐</span>
                                                                            <div>
                                                                                <p className="text-xs font-bold text-orange-700">External Transfer</p>
                                                                                <p className="text-xs text-orange-600">
                                                                                    {!counterpartyAcc?.owned ? 'To external party' : 'From external party'}
                                                                                </p>
                                                                            </div>
                                                                        </div>
                                                                    ) : (
                                                                        <p className="text-xs text-slate-500">Select both accounts to see transfer type</p>
                                                                    )}
                                                                </div>
                                                            );
                                                        }
                                                        return null;
                                                    })()}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Asset Row */}
                                    <div className="mb-4 bg-slate-50 p-4">
                                        <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-[2fr_1fr_1fr]">
                                            <div>
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
                                                    size="xs"
                                                />
                                                {/* Show asset suggestions when source symbol is provided */}
                                                {formData.source_asset_symbol && !formData.asset_id && (() => {
                                                    const suggestions = getAssetSuggestions(formData.source_asset_symbol, assets, 0.5, 3);
                                                    return suggestions.length > 0 ? (
                                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                                            <span className="text-xs text-slate-500">Suggestions:</span>
                                                            {suggestions.map((s, idx) => (
                                                                <Tooltip
                                                                    key={idx}
                                                                    content={`${formatConfidence(s.confidence)} match`}
                                                                    openDelay={100}
                                                                >
                                                                    <Badge
                                                                        colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                        className="cursor-pointer"
                                                                        onClick={() => handleInputChange('asset_id', s.item.asset_id!)}
                                                                    >
                                                                        {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                    </Badge>
                                                                </Tooltip>
                                                            ))}
                                                        </div>
                                                    ) : null;
                                                })()}
                                            </div>
                                            <div>
                                                <Label>Source Symbol</Label>
                                                <Input
                                                    placeholder="Original symbol"
                                                    value={formData.source_asset_symbol}
                                                    onChange={e => handleInputChange('source_asset_symbol', e.target.value.toUpperCase())}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <Label required>Quantity</Label>
                                                <Input
                                                    type="number"
                                                    step="any"
                                                    placeholder="0.00"
                                                    value={formData.quantity}
                                                    onChange={e => handleInputChange('quantity', e.target.value)}
                                                    className="h-7 text-xs font-semibold"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                </div>
                            </div>
                        </div>

                        {/* Section 3: Pricing & Fees - 50% */}
                        <div className="flex-1">
                            <div className="h-full overflow-visible border border-slate-200 bg-white shadow-sm">
                                <div className="bg-green-50 px-3 py-2">
                                    <h3 className="text-xs font-semibold text-green-700">💰 Pricing & Fees</h3>
                                </div>
                                <div className="p-3">
                                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                                        {/* Price Section */}
                                        <div>
                                            <p className="mb-3 text-xs font-bold uppercase text-slate-500">Price</p>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <Label>Unit Price</Label>
                                                    <Input
                                                        type="number"
                                                        step="any"
                                                        placeholder="0.00"
                                                        value={formData.price}
                                                        onChange={e => handleInputChange('price', e.target.value)}
                                                        className="h-7 text-xs"
                                                    />
                                                </div>
                                                <div>
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
                                                        size="xs"
                                                    />
                                                    {/* Show suggestions when source symbol is provided */}
                                                    {formData.source_price_quote_asset_symbol && !formData.price_quote_asset_id && (() => {
                                                        const suggestions = getAssetSuggestions(formData.source_price_quote_asset_symbol, assets, 0.5, 3);
                                                        return suggestions.length > 0 ? (
                                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                                <span className="text-xs text-slate-500">Suggestions:</span>
                                                                {suggestions.map((s, idx) => (
                                                                    <Tooltip
                                                                        key={idx}
                                                                        content={`${formatConfidence(s.confidence)} match`}
                                                                        openDelay={100}
                                                                    >
                                                                        <Badge
                                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                            className="cursor-pointer"
                                                                            onClick={() => handleInputChange('price_quote_asset_id', s.item.asset_id!)}
                                                                        >
                                                                            {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                        </Badge>
                                                                    </Tooltip>
                                                                ))}
                                                            </div>
                                                        ) : null;
                                                    })()}
                                                </div>
                                            </div>
                                            <div className="mt-3">
                                                <Label>Total Value</Label>
                                                <Input
                                                    type="number"
                                                    step="any"
                                                    placeholder="Auto: Price × Quantity"
                                                    value={formData.total}
                                                    onChange={e => handleInputChange('total', e.target.value)}
                                                    className="h-7 bg-slate-50 text-xs"
                                                />
                                            </div>
                                        </div>

                                        {/* Fee Section */}
                                        <div>
                                            <p className="mb-3 text-xs font-bold uppercase text-slate-500">Fee</p>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <Label>Fee Amount</Label>
                                                    <Input
                                                        type="number"
                                                        step="any"
                                                        placeholder="0.00"
                                                        value={formData.fee}
                                                        onChange={e => handleInputChange('fee', e.target.value)}
                                                        className="h-7 text-xs"
                                                    />
                                                </div>
                                                <div>
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
                                                        size="xs"
                                                    />
                                                    {/* Show suggestions when source symbol is provided */}
                                                    {formData.source_fee_quote_asset_symbol && !formData.fee_quote_asset_id && (() => {
                                                        const suggestions = getAssetSuggestions(formData.source_fee_quote_asset_symbol, assets, 0.5, 3);
                                                        return suggestions.length > 0 ? (
                                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                                <span className="text-xs text-slate-500">Suggestions:</span>
                                                                {suggestions.map((s, idx) => (
                                                                    <Tooltip
                                                                        key={idx}
                                                                        content={`${formatConfidence(s.confidence)} match`}
                                                                        openDelay={100}
                                                                    >
                                                                        <Badge
                                                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                                            className="cursor-pointer"
                                                                            onClick={() => handleInputChange('fee_quote_asset_id', s.item.asset_id!)}
                                                                        >
                                                                            {s.item.symbol}{s.confidence >= 0.9 && ' ✓'}
                                                                        </Badge>
                                                                    </Tooltip>
                                                                ))}
                                                            </div>
                                                        ) : null;
                                                    })()}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* P&L Options */}
                                    <div className="mt-4 flex gap-6 border-t border-slate-200 pt-4">
                                        <label className="flex items-center gap-1 text-xs">
                                            <input
                                                type="checkbox"
                                                checked={formData.include_fee}
                                                onChange={(e) => handleInputChange('include_fee', e.target.checked)}
                                                className="h-4 w-4 cursor-pointer accent-blue-500"
                                            />
                                            Include Fee in P&L
                                        </label>
                                        <select
                                            title="Taxability Status"
                                            value={formData.taxability_status}
                                            onChange={(e) => handleInputChange('taxability_status', e.target.value)}
                                            className="h-7 max-w-[160px] border border-slate-200 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        >
                                            <option value="unknown">Unknown</option>
                                            <option value="taxable">Taxable</option>
                                            <option value="non_taxable">Non-Taxable</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Section 4: Tags (1/3) + Network & Advanced (2/3) side by side */}
                    <div className="flex flex-col gap-4 lg:flex-row">
                        {/* Tags - 1/3 */}
                        <div className="min-w-0 flex-1">
                            <div className="h-full overflow-hidden border border-slate-200 bg-white shadow-sm">
                                <div className="bg-purple-50 px-3 py-2">
                                    <h3 className="text-xs font-semibold text-purple-700">🏷️ Tags</h3>
                                </div>
                                <div className="p-3">
                                    <p className="mb-3 text-xs text-slate-500">
                                        Add key-value tags to categorize this transaction
                                    </p>

                                    {/* Selected tags */}
                                    {formData.tags.length > 0 && (
                                        <div className="mb-3 flex flex-wrap gap-2">
                                            {formData.tags.map((tag, idx) => (
                                                <Badge
                                                    key={idx}
                                                    colorScheme="purple"
                                                    className="cursor-pointer"
                                                    onClick={() => handleInputChange('tags', formData.tags.filter((_, i) => i !== idx))}
                                                    title="Click to remove"
                                                >
                                                    {tag.key}: {tag.value} ✕
                                                </Badge>
                                            ))}
                                        </div>
                                    )}

                                    {/* Add new tag */}
                                    <div className="mb-3 flex gap-2">
                                        <Input
                                            placeholder="Key (e.g., category)"
                                            value={newTagKey}
                                            onChange={e => setNewTagKey(e.target.value)}
                                            className="h-7 flex-1 text-xs"
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
                                            className="h-7 flex-1 text-xs"
                                        />
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7"
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
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Network & Advanced - 2/3 */}
                        <div className="flex-[2]">
                            <div className="overflow-visible border border-slate-200 bg-white shadow-sm">
                                <button
                                    type="button"
                                    title={showAdvanced ? 'Hide Network & Advanced' : 'Show Network & Advanced'}
                                    onClick={() => setShowAdvanced(!showAdvanced)}
                                    className="w-full bg-purple-50 px-4 py-3 text-left transition-colors hover:bg-purple-100"
                                >
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-xs font-semibold text-purple-700">🔗 Network & Advanced</h3>
                                        <span className="text-xs text-purple-600">
                                            {showAdvanced ? '▲ Hide' : '▼ Show'}
                                        </span>
                                    </div>
                                </button>
                                {showAdvanced && (
                                    <div className="p-3">
                                        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                                            <div>
                                                <Label>Network</Label>
                                                <Input
                                                    placeholder="ethereum, base, solana..."
                                                    value={formData.network}
                                                    onChange={e => handleInputChange('network', e.target.value)}
                                                    className="h-7 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <Label>From Address</Label>
                                                <Input
                                                    placeholder="0x..."
                                                    value={formData.from_address}
                                                    onChange={e => handleInputChange('from_address', e.target.value)}
                                                    className="h-7 font-mono text-xs"
                                                />
                                            </div>
                                            <div>
                                                <Label>To Address</Label>
                                                <Input
                                                    placeholder="0x..."
                                                    value={formData.to_address}
                                                    onChange={e => handleInputChange('to_address', e.target.value)}
                                                    className="h-7 font-mono text-xs"
                                                />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                            <div>
                                                <Label>Transaction Hash</Label>
                                                <Input
                                                    placeholder="0x..."
                                                    value={formData.network_transaction_id}
                                                    onChange={e => handleInputChange('network_transaction_id', e.target.value)}
                                                    className="h-7 font-mono text-xs"
                                                />
                                            </div>
                                            <div>
                                                <Label>Token Contract</Label>
                                                <Input
                                                    placeholder="0x..."
                                                    value={formData.token_contract_address}
                                                    onChange={e => handleInputChange('token_contract_address', e.target.value)}
                                                    className="h-7 font-mono text-xs"
                                                />
                                            </div>
                                        </div>
                                        <div className="mt-4">
                                            <Label>Review Notes</Label>
                                            <Input
                                                placeholder="Add any notes about this transaction..."
                                                value={formData.review_notes}
                                                onChange={e => handleInputChange('review_notes', e.target.value)}
                                                className="h-7 text-xs"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                </div>

                {/* Sticky Action Bar */}
                <div className="sticky bottom-0 z-10 mt-6 border-t border-slate-200 bg-white py-4">
                    <div className="flex justify-end gap-3">
                        <Button
                            variant="ghost"
                            onClick={handleClear}
                            disabled={loading}
                            size="sm"
                        >
                            Clear
                        </Button>
                        <Button
                            type="submit"
                            colorScheme="blue"
                            disabled={loading}
                            size="sm"
                            className="px-6"
                        >
                            {loading ? <Spinner size="xs" className="mr-2" /> : null}
                            {loading ? 'Creating...' : '➕ Create Transaction'}
                        </Button>
                    </div>
                </div>
            </form>

            {/* Recent Transactions */}
            {recentTransactions.length > 0 && (
                <div className="mt-8 border border-slate-200 bg-white shadow-sm">
                    <div className="bg-slate-50 px-3 py-2">
                        <h3 className="text-xs font-semibold text-slate-700">✨ Recently Created</h3>
                    </div>
                    <div className="p-3">
                        <div className="flex flex-col gap-2">
                            {recentTransactions.map(tx => (
                                <div
                                    key={tx.id}
                                    className="flex items-center gap-3 bg-slate-50 p-3 text-xs transition-colors hover:bg-slate-100"
                                >
                                    <Badge colorScheme="purple">#{tx.id}</Badge>
                                    <Badge
                                        colorScheme={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                    >
                                        {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'} {tx.direction}
                                    </Badge>
                                    <span className="font-bold">{tx.quantity}</span>
                                    <span className="text-slate-600">{tx.linked_asset_symbol || tx.source_asset_symbol || 'Unknown'}</span>
                                    <Badge colorScheme="gray" className="border border-slate-300 bg-transparent text-slate-600">{tx.transaction_type}</Badge>
                                    <span className="ml-auto text-xs text-slate-400">
                                        {formatDateTimeLocale(tx.date_time)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
