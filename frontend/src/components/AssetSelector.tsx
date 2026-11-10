import React, { useEffect, useRef, useState } from 'react';
import { API_URL, Asset } from '../types';
import AssetFormDialog, { AssetPrefill } from './AssetFormDialog';
import { Input } from './ui/primitives';
import { linkRawAsset as linkRawAssetApi } from '../utils/rawAccountApi';

interface AssetSelectorProps {
    value: number | null;
    onChange: (assetId: number | null) => void;
    assets: Asset[];
    onAssetCreated?: () => void;
    placeholder?: string;
    defaultSymbol?: string; // Pre-fill new asset symbol
    size?: 'xs' | 'sm' | 'md';
    disabled?: boolean;
    // For linking raw_asset when creating new asset from transaction context
    rawAssetSource?: string;
    rawAssetSymbol?: string;
    /** Token network/contract: link the contract-specific raw asset instead of the plain symbol */
    rawAssetNetwork?: string | null;
    rawAssetContract?: string | null;
}

export const AssetSelector: React.FC<AssetSelectorProps> = ({
    value,
    onChange,
    assets,
    onAssetCreated,
    placeholder = 'Search or select asset...',
    defaultSymbol = '',
    size = 'sm',
    disabled,
    rawAssetSource,
    rawAssetSymbol,
    rawAssetNetwork,
    rawAssetContract,
}) => {
    const [search, setSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [createPrefill, setCreatePrefill] = useState<AssetPrefill>({});
    const containerRef = useRef<HTMLDivElement>(null);

    // Get current asset symbol
    const selectedAsset = assets.find(a => a.asset_id === value);

    // Filter assets by search
    const filteredAssets = assets.filter(a =>
        a.symbol.toLowerCase().includes(search.toLowerCase()) ||
        (a.label && a.label.toLowerCase().includes(search.toLowerCase()))
    );

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const linkRawAsset = async (assetId: number) => {
        // If raw asset context is provided, link the raw_asset to the asset
        if (rawAssetSource && rawAssetSymbol && assetId) {
            try {
                await linkRawAssetApi({
                    source: rawAssetSource,
                    symbol: rawAssetSymbol,
                    network: rawAssetNetwork,
                    contractAddress: rawAssetContract,
                    assetId,
                });
            } catch (linkErr) {
                console.warn('Failed to link raw asset:', linkErr);
                // Don't fail the whole operation if linking fails
            }
        }
    };

    const handleSelect = async (assetId: number | null) => {
        onChange(assetId);
        setIsOpen(false);
        setSearch('');

        // Link raw_asset when selecting an existing asset
        if (assetId) {
            await linkRawAsset(assetId);
        }
    };

    const handleFormClose = (createdAssetId?: number) => {
        setShowCreateDialog(false);
        if (createdAssetId) {
            onChange(createdAssetId);
            onAssetCreated?.();
        }
    };

    const openCreateDialog = () => {
        const symbolValue = search || defaultSymbol || rawAssetSymbol;
        setCreatePrefill({
            symbol: symbolValue,
            label: symbolValue,
        });
        setShowCreateDialog(true);
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={containerRef}>
            <Input
                value={isOpen ? search : (selectedAsset ? selectedAsset.symbol : '')}
                onChange={e => {
                    setSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                placeholder={placeholder}
                className="h-6 bg-white px-1.5 text-[11px]"
            />

            {isOpen && (
                <div className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-[250px] overflow-y-auto border border-slate-200 bg-white shadow-lg">
                    {/* Clear selection option */}
                    <div
                        className="cursor-pointer p-2 text-xs text-slate-500 hover:bg-slate-100"
                        onClick={() => handleSelect(null)}
                    >
                        -- Not linked --
                    </div>

                    {/* Filtered assets */}
                    {filteredAssets.map(asset => (
                        <div
                            key={asset.asset_id}
                            className={`cursor-pointer p-2 text-xs hover:bg-blue-100 ${value === asset.asset_id ? 'bg-blue-50' : ''}`}
                            onClick={() => handleSelect(asset.asset_id!)}
                        >
                            <span className="block font-medium">{asset.symbol}</span>
                            {asset.label && <span className="block text-xs text-slate-500">{asset.label}</span>}
                        </div>
                    ))}

                    {/* No results / Create new */}
                    {filteredAssets.length === 0 && (
                        <div className="p-2 text-xs text-slate-500">
                            No assets found
                        </div>
                    )}

                    {/* Create new asset option */}
                    <div
                        className="cursor-pointer border-t border-slate-100 p-2 text-xs text-green-600 hover:bg-green-50"
                        onClick={openCreateDialog}
                    >
                        ➕ Create new asset {search && `"${search.toUpperCase()}"`}
                    </div>
                </div>
            )}

            {/* Create Asset Dialog — delegated to canonical AssetFormDialog */}
            <AssetFormDialog
                isOpen={showCreateDialog}
                onClose={handleFormClose}
                prefill={createPrefill}
                rawAssetSource={rawAssetSource}
                rawAssetSymbol={rawAssetSymbol}
                rawAssetNetwork={rawAssetNetwork}
                rawAssetContract={rawAssetContract}
            />
        </div>
    );
};
