/**
 * AssetFormDialog — Canonical dialog for creating a new asset.
 *
 * Used everywhere in the app: AssetSelector dropdowns, AssetsEditor settings
 * page, TransactionSidePanel quick-create, etc.
 *
 * On successful creation the dialog calls `onClose(createdAssetId)`.
 */

import React, { useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import {
    Badge,
    type BadgeColorScheme,
    Button,
    Input,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
} from './ui/primitives';
import { API_URL, DimensionWithCategories } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { toaster } from './ui/toaster';
import { useAssets } from '../hooks/useAssets';

const VALID_BADGE_COLORS: BadgeColorScheme[] = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toBadgeColor = (c: string): BadgeColorScheme =>
    (VALID_BADGE_COLORS as string[]).includes(c) ? (c as BadgeColorScheme) : 'gray';

export interface AssetPrefill {
    symbol?: string;
    label?: string;
    price_type?: string;
}

interface AssetFormDialogProps {
    isOpen: boolean;
    onClose: (createdAssetId?: number) => void;
    prefill?: AssetPrefill;
    /** If provided, link the raw_asset to the newly created asset. */
    rawAssetSource?: string;
    rawAssetSymbol?: string;
}

const AssetFormDialog: React.FC<AssetFormDialogProps> = ({
    isOpen,
    onClose,
    prefill,
    rawAssetSource,
    rawAssetSymbol,
}) => {
    const { assets: allAssets, refetchAssets } = useAssets();
    const [formData, setFormData] = useState({
        symbol: prefill?.symbol || '',
        label: prefill?.label || '',
        isin: '',
        price_type: prefill?.price_type || '',
        tags: [] as Record<string, any>[],
        status: 0,
        denomination_currency_id: null as number | null,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Category selection
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>([]);
    const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number>>(new Set());
    const [isFetchingCategories, setIsFetchingCategories] = useState(false);
    const [activeCategoryTab, setActiveCategoryTab] = useState<string>('');

    const fiatAssets = React.useMemo(
        () => allAssets.filter(a => a.price_type === 'fiat' && a.asset_id),
        [allAssets]
    );

    // Fetch categories lazily when dialog opens
    const fetchCategoriesIfNeeded = async () => {
        if (dimensionData.length > 0 || isFetchingCategories) return;
        setIsFetchingCategories(true);
        try {
            const response = await fetch(`${API_URL}/categories/by-dimension`);
            if (response.ok) {
                const data: DimensionWithCategories[] = await response.json();
                setDimensionData(data);
                setActiveCategoryTab(data[0]?.label || '');
            }
        } catch (err) {
            console.warn('Failed to fetch categories:', err);
        } finally {
            setIsFetchingCategories(false);
        }
    };

    // Reset form when dialog opens with new prefill
    React.useEffect(() => {
        if (isOpen) {
            setFormData({
                symbol: prefill?.symbol?.toUpperCase() || '',
                label: prefill?.label || prefill?.symbol || '',
                isin: '',
                price_type: prefill?.price_type || '',
                tags: [],
                status: 0,
                denomination_currency_id: null,
            });
            setSelectedCategoryIds(new Set());
            setError('');
            fetchCategoriesIfNeeded();
        }
    }, [isOpen, prefill?.symbol, prefill?.label, prefill?.price_type]);

    const linkRawAsset = async (assetId: number) => {
        if (!rawAssetSource || !rawAssetSymbol || !assetId) return;
        try {
            const patchResponse = await fetch(
                `${API_URL}/raw-assets/${encodeURIComponent(rawAssetSource)}/${encodeURIComponent(rawAssetSymbol)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId }),
                }
            );
            if (patchResponse.status === 404) {
                await fetch(`${API_URL}/raw-assets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: rawAssetSymbol,
                        source: rawAssetSource,
                        asset_id: assetId,
                    }),
                });
            }
        } catch (err) {
            console.warn('Failed to link raw asset:', err);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.symbol.trim()) {
            setError('Symbol is required');
            return;
        }

        setLoading(true);
        setError('');
        try {
            const response = await fetch(`${API_URL}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: formData.symbol.toUpperCase(),
                    label: formData.label || null,
                    isin: formData.isin || null,
                    price_type: formData.price_type || null,
                    tags: formData.tags.length > 0 ? formData.tags : null,
                    status: formData.status,
                    denomination_currency_id: formData.denomination_currency_id,
                }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create asset');
            }

            const created = await response.json();

            // Link raw_asset if context provided
            if (created.asset_id) {
                await linkRawAsset(created.asset_id);

                // Assign categories if any selected
                if (selectedCategoryIds.size > 0) {
                    try {
                        await fetch(`${API_URL}/categories/asset/${created.asset_id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ category_ids: Array.from(selectedCategoryIds) }),
                        });
                    } catch (catErr) {
                        console.warn('Failed to assign categories:', catErr);
                    }
                }
            }

            refetchAssets();
            toaster.success({ title: `Asset "${formData.symbol}" created` });
            onClose(created.asset_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create asset');
        } finally {
            setLoading(false);
        }
    };

    return (
        <RadixDialog.Root
            open={isOpen}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2000] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2000] max-h-[92vh] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto bg-white shadow-xl">
                    <form onSubmit={handleSubmit}>
                        <div className="border-b border-gray-200 px-4 py-3">
                            <RadixDialog.Title className="text-base font-semibold">Create New Asset</RadixDialog.Title>
                        </div>
                        <div className="px-4 py-3">
                            <div className="flex flex-col gap-4">
                                {error && (
                                    <span className="text-sm text-red-500">
                                        {error}
                                    </span>
                                )}
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Symbol *
                                    </span>
                                    <Input
                                        placeholder="e.g., BTC, ETH, USDT"
                                        value={formData.symbol}
                                        onChange={(e) =>
                                            setFormData({ ...formData, symbol: e.target.value.toUpperCase() })
                                        }
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Label
                                    </span>
                                    <Input
                                        placeholder="e.g., Bitcoin, Ethereum"
                                        value={formData.label}
                                        onChange={(e) =>
                                            setFormData({ ...formData, label: e.target.value })
                                        }
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        ISIN
                                    </span>
                                    <Input
                                        placeholder="e.g., US0378331005"
                                        value={formData.isin}
                                        onChange={(e) =>
                                            setFormData({ ...formData, isin: e.target.value.toUpperCase() })
                                        }
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Type
                                    </span>
                                    <ComboSelect
                                        value={formData.price_type}
                                        onChange={(val) =>
                                            setFormData({ ...formData, price_type: val })
                                        }
                                        options={ASSET_TYPE_OPTIONS}
                                        placeholder="Select or type..."
                                        width="100%"
                                        size="md"
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Tags
                                    </span>
                                    <Input
                                        placeholder="e.g., defi, layer1, stablecoin (comma-separated)"
                                        value={formData.tags
                                            .map((t) => Object.keys(t)[0])
                                            .filter(Boolean)
                                            .join(', ')}
                                        onChange={(e) => {
                                            const tagStrings = e.target.value
                                                .split(',')
                                                .map((t) => t.trim())
                                                .filter((t) => t);
                                            const tags = tagStrings.map((tag) => ({ [tag]: true }));
                                            setFormData({ ...formData, tags });
                                        }}
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Denomination Currency
                                    </span>
                                    <select
                                        className="h-9 w-full border border-gray-300 px-2 text-sm"
                                        value={String(formData.denomination_currency_id ?? '')}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                denomination_currency_id: e.target.value ? parseInt(e.target.value) : null,
                                            })
                                        }
                                    >
                                        <option value="">— Not set —</option>
                                        {fiatAssets.map(a => (
                                            <option key={a.asset_id} value={String(a.asset_id)}>
                                                {a.symbol}{a.label ? ` (${a.label})` : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Status
                                    </span>
                                    <select
                                        className="h-9 w-full border border-gray-300 px-2 text-sm"
                                        value={String(formData.status)}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                status: parseInt(e.target.value),
                                            })
                                        }
                                    >
                                        <option value="0">Active</option>
                                        <option value="1">Inactive</option>
                                    </select>
                                </div>

                                {/* Category Selection */}
                                {dimensionData.length > 0 && (
                                    <div>
                                        <span className="mb-1 block font-medium">Categories</span>
                                        <div className="max-h-[300px] overflow-y-auto border border-gray-200 p-2">
                                            <Tabs value={activeCategoryTab} onValueChange={setActiveCategoryTab}>
                                                <TabsList>
                                                    {dimensionData.map(dim => (
                                                        <TabsTrigger key={dim.id} value={dim.label}>
                                                            {dim.label}
                                                        </TabsTrigger>
                                                    ))}
                                                </TabsList>
                                                {dimensionData.map(dim => (
                                                    <TabsContent key={dim.id} value={dim.label}>
                                                        <div className="mt-2 flex flex-col gap-1">
                                                            {dim.categories.map(cat => (
                                                                <div
                                                                    key={cat.id}
                                                                    className="flex cursor-pointer items-center gap-2 p-1 hover:bg-gray-50"
                                                                    onClick={() => {
                                                                        setSelectedCategoryIds(prev => {
                                                                            const next = new Set(prev);
                                                                            if (next.has(cat.id)) next.delete(cat.id);
                                                                            else next.add(cat.id);
                                                                            return next;
                                                                        });
                                                                    }}
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={selectedCategoryIds.has(cat.id)}
                                                                        onChange={() => { }}
                                                                        style={{ cursor: 'pointer' }}
                                                                    />
                                                                    <Badge
                                                                        colorScheme={toBadgeColor(cat.color || 'gray')}
                                                                    >
                                                                        {cat.label}
                                                                    </Badge>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </TabsContent>
                                                ))}
                                            </Tabs>
                                            {selectedCategoryIds.size > 0 && (
                                                <div className="mt-2 border-t border-gray-100 pt-2">
                                                    <span className="mb-1 block text-xs text-gray-500">
                                                        Selected ({selectedCategoryIds.size}):
                                                    </span>
                                                    <div className="flex flex-wrap gap-1">
                                                        {Array.from(selectedCategoryIds).map(catId => {
                                                            const cat = dimensionData
                                                                .flatMap(d => d.categories)
                                                                .find(c => c.id === catId);
                                                            if (!cat) return null;
                                                            return (
                                                                <Badge
                                                                    key={catId}
                                                                    colorScheme={toBadgeColor(cat.color || 'gray')}
                                                                    className="text-[10px]"
                                                                >
                                                                    {cat.label}
                                                                </Badge>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
                            <Button variant="outline" onClick={() => onClose()}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                colorScheme="green"
                                loading={loading}
                                disabled={!formData.symbol.trim()}
                            >
                                Create
                            </Button>
                        </div>
                    </form>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default AssetFormDialog;
