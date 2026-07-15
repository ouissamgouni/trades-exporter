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

    // Provisional cost lot — acquisition TX missing, cost estimated at zero
    if (warningType === 'provisional_cost_lot') {
        return {
            colorPalette: 'orange',
            icon: '⏳',
            level: 'warning',
        };
    }

    // Unsettled negative lot — disposal before acquisition, negative balance
    if (warningType === 'unsettled_negative_lot') {
        return {
            colorPalette: 'red',
            icon: '📉',
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

    // FMV fetch failures — price service could not retrieve a quote
    if (warningType === 'fmv_fetch_failed') {
        return {
            colorPalette: 'purple',
            icon: '💰',
            level: 'warning',
        };
    }

    // Zero-cost lot — phantom gains risk
    if (warningType === 'zero_cost_lot') {
        return {
            colorPalette: 'orange',
            icon: '⚠️',
            level: 'warning',
        };
    }

    // Unmatched group — disposal group could not be paired
    if (warningType === 'unmatched_group') {
        return {
            colorPalette: 'orange',
            icon: '⚠️',
            level: 'warning',
        };
    }

    // Fee consumption failed — non-critical
    if (warningType === 'fee_consumption_failed') {
        return {
            colorPalette: 'gray',
            icon: 'ℹ️',
            level: 'info',
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
