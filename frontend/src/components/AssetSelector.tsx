import {
    Box,
    Input,
    Text,
} from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { API_URL, Asset } from '../types';
import AssetFormDialog, { AssetPrefill } from './AssetFormDialog';

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
                // First try to PATCH (update existing raw asset)
                const patchResponse = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAssetSource)}/${encodeURIComponent(rawAssetSymbol)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId })
                });

                // If raw asset doesn't exist (404), create it
                if (patchResponse.status === 404) {
                    await fetch(`${API_URL}/raw-assets`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            symbol: rawAssetSymbol,
                            source: rawAssetSource,
                            asset_id: assetId
                        })
                    });
                }
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
        const symbolValue = search || rawAssetSymbol || defaultSymbol;
        setCreatePrefill({
            symbol: symbolValue,
            label: symbolValue,
        });
        setShowCreateDialog(true);
        setIsOpen(false);
    };

    return (
        <Box position="relative" ref={containerRef}>
            <Input
                size={size}
                value={isOpen ? search : (selectedAsset ? selectedAsset.symbol : '')}
                onChange={e => {
                    setSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                placeholder={placeholder}
                bg="white"
            />

            {isOpen && (
                <Box
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    zIndex={1000}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    maxH="250px"
                    overflowY="auto"
                    mt={1}
                >
                    {/* Clear selection option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'gray.100' }}
                        onClick={() => handleSelect(null)}
                        color="gray.500"
                        fontSize="xs"
                    >
                        -- Not linked --
                    </Box>

                    {/* Filtered assets */}
                    {filteredAssets.map(asset => (
                        <Box
                            key={asset.asset_id}
                            p={2}
                            cursor="pointer"
                            bg={value === asset.asset_id ? 'blue.50' : undefined}
                            _hover={{ bg: 'blue.100' }}
                            onClick={() => handleSelect(asset.asset_id!)}
                            fontSize="xs"
                        >
                            <Text fontWeight="medium">{asset.symbol}</Text>
                            {asset.label && <Text fontSize="xs" color="gray.500">{asset.label}</Text>}
                        </Box>
                    ))}

                    {/* No results / Create new */}
                    {filteredAssets.length === 0 && (
                        <Box p={2} color="gray.500" fontSize="xs">
                            No assets found
                        </Box>
                    )}

                    {/* Create new asset option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'green.50' }}
                        onClick={openCreateDialog}
                        color="green.600"
                        fontSize="xs"
                        borderTop="1px solid"
                        borderColor="gray.100"
                    >
                        ➕ Create new asset {search && `"${search.toUpperCase()}"`}
                    </Box>
                </Box>
            )}

            {/* Create Asset Dialog — delegated to canonical AssetFormDialog */}
            <AssetFormDialog
                isOpen={showCreateDialog}
                onClose={handleFormClose}
                prefill={createPrefill}
                rawAssetSource={rawAssetSource}
                rawAssetSymbol={rawAssetSymbol}
            />
        </Box>
    );
};
