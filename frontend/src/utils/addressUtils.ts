/**
 * Utility functions for formatting blockchain addresses and identifiers
 */

/**
 * Format a wallet address or identifier for display by truncating the middle
 * @param address - The full address or identifier to format
 * @param prefixLength - Number of characters to show at the start (default: 6)
 * @param suffixLength - Number of characters to show at the end (default: 4)
 * @returns Truncated address in format: 0x1234...5678
 */
export function formatAddress(
    address: string | null | undefined,
    prefixLength: number = 6,
    suffixLength: number = 4
): string {
    if (!address) return '';

    // If address is short enough, return as-is
    if (address.length <= prefixLength + suffixLength + 3) {
        return address;
    }

    // Truncate middle with ellipsis
    const prefix = address.slice(0, prefixLength);
    const suffix = address.slice(-suffixLength);
    return `${prefix}...${suffix}`;
}

/**
 * Format a chain name for display (capitalize first letter)
 * @param chain - The chain name (e.g., "base", "ethereum")
 * @returns Formatted chain name (e.g., "Base", "Ethereum")
 */
export function formatChainName(chain: string | null | undefined): string {
    if (!chain) return '';
    return chain.charAt(0).toUpperCase() + chain.slice(1).toLowerCase();
}
