import { Box, Input, Text } from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';

interface ComboSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: string[];
    placeholder?: string;
    size?: 'sm' | 'md';
    width?: string;
}

export const ComboSelect: React.FC<ComboSelectProps> = ({
    value,
    onChange,
    options,
    placeholder = 'Select or type...',
    size = 'sm',
    width = '120px',
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);

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

    // Filter options based on input
    const filteredOptions = options.filter(opt =>
        opt.toLowerCase().includes(inputValue.toLowerCase())
    );

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setInputValue(newValue);
        onChange(newValue);
    };

    const handleFocus = () => {
        setIsOpen(true);
        // Start with empty input so user can type fresh
        setInputValue('');
    };

    const handleSelect = (option: string) => {
        setInputValue(option);
        onChange(option);
        setIsOpen(false);
    };

    // Display value: when closed show the actual value, when open show what user is typing
    const displayValue = isOpen ? inputValue : value;

    return (
        <Box position="relative" ref={containerRef} width={width}>
            <Input
                size={size}
                value={displayValue}
                onChange={handleInputChange}
                onFocus={handleFocus}
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
                    maxH="200px"
                    overflowY="auto"
                    mt={1}
                >
                    {/* Show current value option if it exists and differs from input */}
                    {value && !filteredOptions.includes(value) && value.toLowerCase().includes(inputValue.toLowerCase()) && (
                        <Box
                            p={2}
                            cursor="pointer"
                            bg="blue.50"
                            _hover={{ bg: 'blue.100' }}
                            onClick={() => handleSelect(value)}
                            fontSize="sm"
                            borderBottom="1px solid"
                            borderColor="gray.100"
                        >
                            <Text fontWeight="medium">{value}</Text>
                            <Text fontSize="xs" color="gray.500">current value</Text>
                        </Box>
                    )}

                    {filteredOptions.length > 0 ? (
                        filteredOptions.map(option => (
                            <Box
                                key={option}
                                p={2}
                                cursor="pointer"
                                bg={value === option ? 'blue.50' : undefined}
                                _hover={{ bg: 'blue.100' }}
                                onClick={() => handleSelect(option)}
                                fontSize="sm"
                            >
                                <Text>{option}</Text>
                            </Box>
                        ))
                    ) : inputValue ? (
                        <Box p={2} color="gray.500" fontSize="sm">
                            <Text>Using custom: "{inputValue}"</Text>
                        </Box>
                    ) : (
                        options.map(option => (
                            <Box
                                key={option}
                                p={2}
                                cursor="pointer"
                                bg={value === option ? 'blue.50' : undefined}
                                _hover={{ bg: 'blue.100' }}
                                onClick={() => handleSelect(option)}
                                fontSize="sm"
                            >
                                <Text>{option}</Text>
                            </Box>
                        ))
                    )}
                </Box>
            )}
        </Box>
    );
};

// Predefined options for reuse
export const TRANSACTION_TYPE_OPTIONS = [
    'acquisition',
    'disposal',
    'internal_transfer',
    'swap',
    'bridge',
    'other',
];

export const ASSET_TYPE_OPTIONS = [
    'crypto',  // All crypto: native currencies, tokens, stablecoins, NFTs
    'stock',   // All traditional: stocks, ETFs, indices, commodities
    'fiat',    // Fiat currencies (USD, EUR, GBP)
];

// Legacy alias - will be removed
export const PRICE_TYPE_OPTIONS = ASSET_TYPE_OPTIONS;

export const ACCOUNT_OPTIONS = [
    'binance',
    'mexc',
    'okx',
    'coinbase',
    'onchain',
];

export const SOURCE_OPTIONS = [
    'manual',
    'binance-transactions',
    'binance-deposits',
    'binance-withdrawals',
    'mexc-transactions',
    'okx-transactions',
    'okx-convert',
    'coinbase-transactions',
    'etherscan_token_transfers_ethereum',
    'etherscan_normal_tx_ethereum',
    'blockscout_token_transfers_base',
    'blockscout_base_normal_tx',
];
