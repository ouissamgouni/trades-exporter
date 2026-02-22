/**
 * Warning Styles Utility
 * 
 * Provides consistent styling for warning types across the application.
 * Pending transfer warnings get distinct "warning" severity with orange styling.
 */

import { WarningLevel } from './types';

export interface WarningTypeConfig {
    colorPalette: string;
    icon: string;
    level: WarningLevel;
}

/**
 * Get warning styling based on warning type
 */
export function getWarningTypeConfig(warningType: string): WarningTypeConfig {
    // Unmatched internal transfers are warnings that need user attention
    if (warningType === 'unmatched_internal_transfer') {
        return {
            colorPalette: 'orange',
            icon: '⚠️',
            level: 'warning',
        };
    }

    // Price-related warnings
    if (warningType === 'missing_price' || warningType === 'stale_price') {
        return {
            colorPalette: 'purple',
            icon: '💰',
            level: 'warning',
        };
    }

    // Balance/lot issues
    if (warningType === 'insufficient_lots' || warningType === 'negative_balance') {
        return {
            colorPalette: 'red',
            icon: '🔴',
            level: 'error',
        };
    }

    // Value mismatches
    if (warningType === 'residual_mismatch') {
        return {
            colorPalette: 'yellow',
            icon: '⚖️',
            level: 'warning',
        };
    }

    // Unexpected errors
    if (warningType === 'unexpected_error') {
        return {
            colorPalette: 'red',
            icon: '❌',
            level: 'error',
        };
    }

    // Default for unknown types
    return {
        colorPalette: 'gray',
        icon: 'ℹ️',
        level: 'info',
    };
}
