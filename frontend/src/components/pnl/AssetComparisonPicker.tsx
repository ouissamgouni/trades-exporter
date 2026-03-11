/**
 * AssetComparisonPicker — multi-select asset chip bar.
 *
 * Renders selected assets as colored Tag chips with remove button,
 * plus an "+ Add" button that opens a search popover.
 * Each chip's color dot matches its line in the comparison chart.
 */
import React, { useMemo, useState, useRef } from 'react';
import { Badge, Box, Flex, Input, Text } from '@chakra-ui/react';
import { FiX, FiPlus } from 'react-icons/fi';
import { CATEGORY_COLOR_PALETTE } from '../../constants/colors';
import type { AssetPnLRow } from './types';

interface AssetComparisonPickerProps {
    /** All available assets for selection */
    assets: AssetPnLRow[];
    /** Currently selected asset IDs (order determines color assignment) */
    selectedIds: number[];
    /** Called when selection changes */
    onChange: (ids: number[]) => void;
    /** Max number of assets that can be selected (default 10) */
    maxSelections?: number;
}

export const AssetComparisonPicker: React.FC<AssetComparisonPickerProps> = ({
    assets,
    selectedIds,
    onChange,
    maxSelections = 10,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Map asset id → asset for quick lookup
    const assetMap = useMemo(() => {
        const m = new Map<number, AssetPnLRow>();
        for (const a of assets) {
            if (a.asset.id != null) m.set(a.asset.id, a);
        }
        return m;
    }, [assets]);

    // Filtered options for dropdown (not already selected, matching search)
    const filteredOptions = useMemo(() => {
        const selectedSet = new Set(selectedIds);
        const q = search.toLowerCase().trim();
        return assets.filter(a => {
            if (a.asset.id == null) return false;
            if (selectedSet.has(a.asset.id)) return false;
            if (!q) return true;
            const sym = (a.asset.symbol || '').toLowerCase();
            const label = (a.asset.label || '').toLowerCase();
            return sym.includes(q) || label.includes(q);
        }).slice(0, 20); // Cap for performance
    }, [assets, selectedIds, search]);

    const handleRemove = (id: number) => {
        onChange(selectedIds.filter(x => x !== id));
    };

    const handleAdd = (id: number) => {
        if (selectedIds.length >= maxSelections) return;
        onChange([...selectedIds, id]);
        setSearch('');
        setIsOpen(false);
    };

    const atMax = selectedIds.length >= maxSelections;

    return (
        <Flex wrap="wrap" gap={2} align="center" position="relative">
            {/* Selected asset chips */}
            {selectedIds.map((id, idx) => {
                const asset = assetMap.get(id);
                if (!asset) return null;
                const color = CATEGORY_COLOR_PALETTE[idx % CATEGORY_COLOR_PALETTE.length];
                return (
                    <Badge
                        key={id}
                        variant="outline"
                        size="sm"
                        px={2}
                        py={1}
                        borderRadius="full"
                        display="flex"
                        alignItems="center"
                        gap={1}
                        cursor="pointer"
                        _hover={{ bg: 'gray.50' }}
                        onClick={() => handleRemove(id)}
                    >
                        <Box w="8px" h="8px" borderRadius="full" bg={color} flexShrink={0} />
                        <Text fontSize="xs" fontWeight="medium">
                            {asset.asset.symbol || asset.asset.label || `#${id}`}
                        </Text>
                        <Box as={FiX} fontSize="10px" color="gray.500" />
                    </Badge>
                );
            })}

            {/* Add button + popover */}
            <Box position="relative">
                <Badge
                    variant={atMax ? 'subtle' : 'outline'}
                    size="sm"
                    px={2}
                    py={1}
                    borderRadius="full"
                    cursor={atMax ? 'not-allowed' : 'pointer'}
                    opacity={atMax ? 0.5 : 1}
                    display="flex"
                    alignItems="center"
                    gap={1}
                    onClick={() => {
                        if (!atMax) {
                            setIsOpen(prev => !prev);
                            setTimeout(() => inputRef.current?.focus(), 50);
                        }
                    }}
                >
                    <Box as={FiPlus} fontSize="10px" />
                    <Text fontSize="xs">{atMax ? `Max ${maxSelections}` : 'Add'}</Text>
                </Badge>

                {isOpen && !atMax && (
                    <Box
                        position="absolute"
                        top="100%"
                        left={0}
                        mt={1}
                        zIndex={20}
                        bg="white"
                        border="1px solid"
                        borderColor="gray.200"
                        borderRadius="md"
                        boxShadow="lg"
                        w="240px"
                        maxH="260px"
                        overflow="hidden"
                    >
                        <Box p={2} borderBottom="1px solid" borderColor="gray.100">
                            <Input
                                ref={inputRef}
                                size="sm"
                                placeholder="Search assets..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') {
                                        setIsOpen(false);
                                        setSearch('');
                                    }
                                }}
                            />
                        </Box>
                        <Box maxH="200px" overflowY="auto">
                            {filteredOptions.length === 0 ? (
                                <Text fontSize="xs" color="gray.400" p={3} textAlign="center">
                                    No assets found
                                </Text>
                            ) : (
                                filteredOptions.map(a => (
                                    <Flex
                                        key={a.asset.id}
                                        px={3}
                                        py={1.5}
                                        align="center"
                                        gap={2}
                                        cursor="pointer"
                                        _hover={{ bg: 'blue.50' }}
                                        onClick={() => handleAdd(a.asset.id!)}
                                    >
                                        <Text fontSize="xs" fontWeight="medium" flex={1}>
                                            {a.asset.symbol}
                                        </Text>
                                        {a.asset.label && a.asset.label !== a.asset.symbol && (
                                            <Text fontSize="xs" color="gray.400" truncate maxW="100px">
                                                {a.asset.label}
                                            </Text>
                                        )}
                                    </Flex>
                                ))
                            )}
                        </Box>
                    </Box>
                )}
            </Box>

            {/* Click-away layer */}
            {isOpen && (
                <Box
                    position="fixed"
                    inset={0}
                    zIndex={19}
                    onClick={() => { setIsOpen(false); setSearch(''); }}
                />
            )}
        </Flex>
    );
};
