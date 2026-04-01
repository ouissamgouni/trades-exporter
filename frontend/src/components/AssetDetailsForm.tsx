/**
 * AssetDetailsForm — Inline-editable 2-column detail fields for asset properties.
 *
 * Uses the same EditableField pattern as TransactionSidePanel:
 * click label/value row to edit, save on blur/enter, cancel on escape.
 */

import React from 'react';
import { Badge, Box, Flex, SimpleGrid, Text } from '@chakra-ui/react';
import { API_URL, Asset } from '../types';
import { EditableField } from './EditableField';
import { toaster } from './ui/toaster';

const NOOP = async () => {};

const PRICE_TYPE_OPTIONS = [
    { label: '— Not set —', value: '' },
    { label: 'crypto', value: 'crypto' },
    { label: 'stock', value: 'stock' },
    { label: 'fiat', value: 'fiat' },
];

const STATUS_OPTIONS = [
    { label: 'Active', value: '0' },
    { label: 'Inactive', value: '1' },
];

interface AssetDetailsFormProps {
    asset: Asset;
    onSaved?: () => void;
}

export const AssetDetailsForm: React.FC<AssetDetailsFormProps> = ({ asset, onSaved }) => {
    const patchField = async (field: string, rawValue: string) => {
        if (!asset.asset_id) return;
        const value = field === 'status' ? parseInt(rawValue) : rawValue;
        const response = await fetch(`${API_URL}/assets/${asset.asset_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
        });
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || 'Failed to update');
        }
        toaster.success({ title: 'Asset updated' });
        onSaved?.();
    };

    return (
        <Box>
            <SimpleGrid columns={3} gap={0} css={{ columnGap: '32px' }}>
                {/* Column 1 */}
                <Box css={{ '& > div': { justifyContent: 'flex-start' } }}>
                    <EditableField
                        label="Asset ID"
                        value={asset.asset_id != null ? `#${asset.asset_id}` : '-'}
                        onSave={NOOP}
                        editable={false}
                        muted
                        copyable
                    />
                    <EditableField
                        label="Symbol"
                        value={asset.symbol || ''}
                        onSave={v => patchField('symbol', v)}
                    />
                </Box>
                {/* Column 2 */}
                <Box css={{ '& > div': { justifyContent: 'flex-start' } }}>
                    <EditableField
                        label="Created"
                        value={asset.created_at ? new Date(asset.created_at).toLocaleDateString() : '-'}
                        onSave={NOOP}
                        editable={false}
                        muted
                    />
                    <EditableField
                        label="Label"
                        value={asset.label || ''}
                        onSave={v => patchField('label', v)}
                    />
                </Box>
                {/* Column 3 */}
                <Box css={{ '& > div': { justifyContent: 'flex-start' } }}>
                    <EditableField
                        label="Price Type"
                        value={asset.price_type || ''}
                        type="select"
                        options={PRICE_TYPE_OPTIONS}
                        onSave={v => patchField('price_type', v)}
                    />
                    <EditableField
                        label="Status"
                        value={String(asset.status ?? 0)}
                        type="select"
                        options={STATUS_OPTIONS}
                        displayValue={
                            <Badge size="xs" colorPalette={asset.status === 0 ? 'green' : 'gray'}>
                                {asset.status === 0 ? 'Active' : 'Inactive'}
                            </Badge>
                        }
                        onSave={v => patchField('status', v)}
                    />
                </Box>
            </SimpleGrid>

            {/* Tags (read-only) */}
            {asset.tags && asset.tags.length > 0 && (
                <Flex py={0.5} gap={2} align="center" mt={1}>
                    <Text fontSize="10px" color="gray.500" flexShrink={0}>Tags</Text>
                    <Flex gap={1} flexWrap="wrap" justify="flex-end" flex={1}>
                        {asset.tags.map((tag, i) => (
                            <Badge key={i} size="xs" colorPalette="blue" variant="subtle" fontSize="9px">
                                {Object.entries(tag).map(([k, v]) => `${k}: ${v}`).join(', ')}
                            </Badge>
                        ))}
                    </Flex>
                </Flex>
            )}
        </Box>
    );
};

export default AssetDetailsForm;
