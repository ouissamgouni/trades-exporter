/**
 * Account Colors Utility
 * 
 * Provides deterministic color generation for accounts based on their ID.
 * Colors are consistent across the app (filter chips, expanded rows, charts).
 */

// Curated palette of distinct, accessible colors
// Designed to be distinguishable for colorblind users
const ACCOUNT_COLOR_PALETTE = [
    '#3182CE', // Blue
    '#38A169', // Green
    '#DD6B20', // Orange
    '#805AD5', // Purple
    '#D53F8C', // Pink
    '#00B5D8', // Cyan
    '#D69E2E', // Yellow
    '#E53E3E', // Red
    '#319795', // Teal
    '#718096', // Gray
    '#9F7AEA', // Light Purple
    '#F6AD55', // Light Orange
    '#68D391', // Light Green
    '#63B3ED', // Light Blue
    '#FC8181', // Light Red
    '#B794F4', // Lavender
] as const;

/**
 * Get a deterministic color for an account based on its ID.
 * Same account ID will always return the same color.
 * 
 * @param accountId - The account's numeric ID
 * @returns A hex color string
 */
export function getAccountColor(accountId: number): string {
    const index = accountId % ACCOUNT_COLOR_PALETTE.length;
    return ACCOUNT_COLOR_PALETTE[index];
}

/**
 * Get account color with optional opacity for backgrounds.
 * 
 * @param accountId - The account's numeric ID
 * @param opacity - Opacity value between 0 and 1 (default: 1)
 * @returns An rgba color string
 */
export function getAccountColorWithOpacity(accountId: number, opacity: number = 1): string {
    const hex = getAccountColor(accountId);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Generate a map of account IDs to colors for a set of accounts.
 * Useful for charts that need consistent coloring.
 * 
 * @param accountIds - Array of account IDs
 * @returns Map of accountId -> color
 */
export function getAccountColorMap(accountIds: number[]): Map<number, string> {
    const colorMap = new Map<number, string>();
    accountIds.forEach(id => {
        colorMap.set(id, getAccountColor(id));
    });
    return colorMap;
}

/**
 * Get the full color palette for reference.
 */
export function getColorPalette(): readonly string[] {
    return ACCOUNT_COLOR_PALETTE;
}

export default {
    getAccountColor,
    getAccountColorWithOpacity,
    getAccountColorMap,
    getColorPalette,
};
