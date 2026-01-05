/**
 * Chart-friendly color palette for categories.
 * Muted, balanced tones suitable for data visualization.
 * Inspired by Tableau/D3 palettes with softer saturation.
 */
export const CATEGORY_COLOR_PALETTE = [
    // Blues
    '#4E79A7', // Steel blue
    '#6B9AC4', // Light steel
    '#2E5A87', // Dark steel

    // Teals & Cyans
    '#59A89C', // Teal
    '#76B7B2', // Soft teal
    '#2D8B84', // Deep teal

    // Greens
    '#8CD17D', // Sage green
    '#59A14F', // Forest green
    '#A0CB8D', // Soft sage

    // Yellows & Ochres
    '#F1CE63', // Soft gold
    '#D4A84B', // Ochre
    '#B6992D', // Dark gold

    // Oranges
    '#F28E2B', // Soft orange
    '#E07B39', // Burnt orange
    '#FF9D5C', // Light coral

    // Reds & Pinks
    '#E15759', // Soft red
    '#D4726A', // Dusty rose
    '#B94A48', // Deep red

    // Purples & Violets
    '#B07AA1', // Dusty purple
    '#9467BD', // Soft violet
    '#7B5A8C', // Deep purple

    // Neutrals
    '#79706E', // Warm gray
    '#A8A39E', // Light taupe
    '#5E5855', // Charcoal
];

/**
 * Default fallback color when no color is set.
 */
export const DEFAULT_CATEGORY_COLOR = '#79706E';

/**
 * Returns the first color from the palette that is not in the usedColors array.
 * If all colors are used, cycles back to the beginning of the palette.
 * 
 * @param usedColors - Array of hex colors currently in use
 * @returns The next available color from the palette
 */
export function getNextAvailableColor(usedColors: string[]): string {
    const normalizedUsed = new Set(usedColors.map(c => c?.toLowerCase()));

    for (const color of CATEGORY_COLOR_PALETTE) {
        if (!normalizedUsed.has(color.toLowerCase())) {
            return color;
        }
    }

    // All colors used, return first palette color
    return CATEGORY_COLOR_PALETTE[0];
}

/**
 * Calculates the relative luminance of a hex color.
 * Used for determining appropriate text contrast.
 * 
 * @param hex - Hex color string (with or without #)
 * @returns Luminance value between 0 and 1
 */
function getLuminance(hex: string): number {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.slice(0, 2), 16) / 255;
    const g = parseInt(cleanHex.slice(2, 4), 16) / 255;
    const b = parseInt(cleanHex.slice(4, 6), 16) / 255;

    const toLinear = (c: number) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Returns an appropriate text color (white or dark) for a given background color.
 * Uses WCAG luminance formula for contrast calculation.
 * 
 * @param backgroundColor - Hex color string for the background
 * @returns '#ffffff' for dark backgrounds, '#1a1a1a' for light backgrounds
 */
export function getContrastTextColor(backgroundColor: string): string {
    if (!backgroundColor || !backgroundColor.startsWith('#')) {
        return '#1a1a1a';
    }

    const luminance = getLuminance(backgroundColor);
    return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}
