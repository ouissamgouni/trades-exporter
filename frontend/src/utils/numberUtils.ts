/**
 * Centralized utility for formatting numbers and quantities across the application.
 * Handles very small values (exponential notation), large values (K/M/B suffixes),
 * and standard decimal formatting.
 */

export interface QuantityFormatOptions {
  /** Threshold below which exponential notation is used (default: 0.0001) */
  exponentialThreshold?: number;
  /** Maximum decimal places for standard formatting (default: 8) */
  maxDecimals?: number;
  /** Whether to use K/M/B suffixes for large numbers (default: true) */
  useLargeNumberSuffixes?: boolean;
  /** Minimum value for K suffix (default: 1000) */
  largeNumberThreshold?: number;
  /** If true, show full precision without truncation or suffixes */
  forceFullPrecision?: boolean;
}

const DEFAULT_OPTIONS: Required<QuantityFormatOptions> = {
  exponentialThreshold: 0.0001,
  maxDecimals: 8,
  useLargeNumberSuffixes: true,
  largeNumberThreshold: 1000,
};

/**
 * Formats a quantity with smart display:
 * - Very small values (< 0.0001): exponential notation (e.g., "1.23e-7")
 * - Small decimals (< 1): up to 8 decimals with trailing zeros removed
 * - Medium values (1-999): up to 4 decimals with trailing zeros removed
 * - Large values (≥ 1K): K/M/B suffixes with 2 decimal places
 * 
 * @param value - The numeric value to format
 * @param options - Optional formatting configuration
 * @returns Formatted string representation of the quantity
 * 
 * @example
 * formatQuantity(0.000000123) // "1.23e-7"
 * formatQuantity(0.00123456) // "0.00123456"
 * formatQuantity(1234.5678) // "1.23K"
 * formatQuantity(1500000) // "1.50M"
 */
export function formatQuantity(
  value: number | null | undefined,
  options: QuantityFormatOptions = {}
): string {
  // Handle null/undefined/zero
  if (value === null || value === undefined || value === 0) {
    return '0';
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const absValue = Math.abs(value);

  // Very small values: use exponential notation
  if (absValue < opts.exponentialThreshold) {
    return value.toExponential(2);
  }

  // Large values: use K/M/B suffixes
  if (opts.useLargeNumberSuffixes && absValue >= opts.largeNumberThreshold) {
    if (absValue >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (absValue >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (absValue >= 1_000) {
      return `${(value / 1_000).toFixed(2)}K`;
    }
  }

  // Small decimals (< 1): use higher precision
  if (absValue < 1) {
    return value.toFixed(opts.maxDecimals).replace(/\.?0+$/, '');
  }

  // Medium values (1-999): use moderate precision
  if (absValue < opts.largeNumberThreshold) {
    return value.toFixed(4).replace(/\.?0+$/, '');
  }

  // Fallback for large numbers when suffixes are disabled
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Formats a quantity with currency symbol.
 * Applies the same smart formatting as formatQuantity but adds currency symbol.
 * 
 * @param value - The numeric value to format
 * @param currency - Currency code (e.g., 'USD', 'EUR')
 * @param options - Optional formatting configuration
 * @returns Formatted string with currency symbol
 * 
 * @example
 * formatQuantityWithCurrency(0.000000123, 'USD') // "$1.23e-7"
 * formatQuantityWithCurrency(1234.56, 'USD') // "$1,234.56"
 * formatQuantityWithCurrency(1500000, 'EUR') // "€1.50M"
 */
export function formatQuantityWithCurrency(
  value: number | null | undefined,
  currency: string,
  options: QuantityFormatOptions = {}
): string {
  if (value === null || value === undefined || value === 0) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0);
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const absValue = Math.abs(value);
  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  });

  // Get currency symbol
  const parts = currencyFormatter.formatToParts(0);
  const currencySymbol = parts.find(p => p.type === 'currency')?.value || currency;

  // Very small values: use exponential notation with currency
  if (absValue < opts.exponentialThreshold) {
    return `${currencySymbol}${value.toExponential(2)}`;
  }

  // Large values: use K/M/B suffixes with currency
  if (opts.useLargeNumberSuffixes && absValue >= opts.largeNumberThreshold) {
    if (absValue >= 1_000_000_000) {
      return `${currencySymbol}${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (absValue >= 1_000_000) {
      return `${currencySymbol}${(value / 1_000_000).toFixed(2)}M`;
    }
    if (absValue >= 1_000) {
      return `${currencySymbol}${(value / 1_000).toFixed(2)}K`;
    }
  }

  // Standard currency formatting for normal values
  return currencyFormatter.format(value);
}

/**
 * Determines whether a tooltip should be shown for a quantity.
 * Returns true only when exponential notation is used, to avoid
 * unnecessary tooltips on normal values.
 * 
 * @param value - The numeric value to check
 * @param options - Optional formatting configuration
 * @returns true if exponential notation will be used
 * 
 * @example
 * shouldShowTooltip(0.000000123) // true (will show "1.23e-7")
 * shouldShowTooltip(1.23) // false (normal display)
 * shouldShowTooltip(1234) // false (will show "1.23K", no tooltip needed)
 */
export function shouldShowTooltip(
  value: number | null | undefined,
  options: QuantityFormatOptions = {}
): boolean {
  if (value === null || value === undefined || value === 0) {
    return false;
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const absValue = Math.abs(value);

  // Only show tooltip when exponential notation is used
  return absValue < opts.exponentialThreshold && absValue !== 0;
}

/**
 * Formats a quantity with full precision for tooltip display.
 * Shows all significant digits without rounding.
 * 
 * @param value - The numeric value to format with full precision
 * @returns Full precision string representation
 * 
 * @example
 * formatQuantityFullPrecision(0.000000123456789) // "0.000000123456789"
 * formatQuantityFullPrecision(1234.56789012345) // "1234.56789012345"
 */
export function formatQuantityFullPrecision(
  value: number | null | undefined
): string {
  if (value === null || value === undefined) {
    return '0';
  }

  // Use toPrecision for full accuracy, then clean up scientific notation if not needed
  const str = value.toString();

  // If the string doesn't contain 'e' (not in scientific notation from toString),
  // it's already in the best format
  if (!str.includes('e')) {
    return str;
  }

  // For scientific notation, convert to fixed with enough precision
  // JavaScript's Number has ~15-17 significant decimal digits
  return value.toFixed(20).replace(/\.?0+$/, '');
}

/**
 * Formats a quantity for compact display in tight spaces.
 * Uses more aggressive rounding and shorter suffixes.
 * 
 * @param value - The numeric value to format
 * @returns Compact string representation
 * 
 * @example
 * formatQuantityCompact(1234567) // "1.2M"
 * formatQuantityCompact(0.000123) // "1.2e-4"
 */
export function formatQuantityCompact(
  value: number | null | undefined
): string {
  return formatQuantity(value, {
    maxDecimals: 4,
    useLargeNumberSuffixes: true,
  });
}
