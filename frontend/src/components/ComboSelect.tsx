import React, { useEffect, useRef, useState } from 'react';

interface ComboSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: string[];
    placeholder?: string;
    size?: 'xs' | 'sm' | 'md';
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
        <div className="relative" ref={containerRef} style={{ width }}>
            <input
                value={displayValue}
                onChange={handleInputChange}
                onFocus={handleFocus}
                placeholder={placeholder}
                className={`w-full border border-slate-300 bg-white px-2 outline-none focus:border-blue-500 ${size === 'xs' ? 'h-6 text-xs' : size === 'sm' ? 'h-8 text-sm' : 'h-9 text-sm'}`}
            />

            {isOpen && (
                <div className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-[200px] overflow-y-auto border border-slate-200 bg-white shadow-lg">
                    {/* Show current value option if it exists and differs from input */}
                    {value && !filteredOptions.includes(value) && value.toLowerCase().includes(inputValue.toLowerCase()) && (
                        <div
                            className="cursor-pointer border-b border-slate-100 bg-blue-50 p-2 text-xs hover:bg-blue-100"
                            onClick={() => handleSelect(value)}
                        >
                            <div className="font-medium">{value}</div>
                            <div className="text-xs text-slate-500">current value</div>
                        </div>
                    )}

                    {filteredOptions.length > 0 ? (
                        filteredOptions.map(option => (
                            <div
                                key={option}
                                className={`cursor-pointer p-2 text-xs hover:bg-blue-100 ${value === option ? 'bg-blue-50' : ''}`}
                                onClick={() => handleSelect(option)}
                            >
                                {option}
                            </div>
                        ))
                    ) : inputValue ? (
                        <div className="p-2 text-xs text-slate-500">
                            Using custom: "{inputValue}"
                        </div>
                    ) : (
                        options.map(option => (
                            <div
                                key={option}
                                className={`cursor-pointer p-2 text-xs hover:bg-blue-100 ${value === option ? 'bg-blue-50' : ''}`}
                                onClick={() => handleSelect(option)}
                            >
                                {option}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
};

// Predefined options for reuse
export const TRANSACTION_TYPE_OPTIONS = [
    'trade',     // Buy/sell exchange of assets
    'transfer',  // Deposits, withdrawals, internal transfers
    'margin',    // Derivative cash flows: funding, perp open/close
    'cost',      // Fee-only: approvals, gas fees, management fees
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
