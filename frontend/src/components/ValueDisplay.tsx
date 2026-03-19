import React from 'react';
import { Tooltip } from './ui/tooltip';
import {
  formatQuantity,
  formatQuantityWithCurrency,
  formatQuantityFullPrecision,
  shouldShowTooltip,
  type QuantityFormatOptions,
} from '../utils/numberUtils';

interface ValueDisplayProps {
  /** The numeric value to display (quantity, price, fee, currency amount, etc.) */
  value: number | null | undefined;
  /** Optional currency code (e.g., 'USD', 'EUR') - adds currency symbol */
  currency?: string;
  /** Optional formatting options */
  options?: QuantityFormatOptions;
  /** Optional CSS class name for the container span */
  className?: string;
  /** Optional inline styles */
  style?: React.CSSProperties;
}

/**
 * Smart component for displaying numeric values with conditional tooltip.
 * Works for quantities, prices, fees, and any other numeric values.
 * 
 * Features:
 * - Displays values using formatQuantity() with exponential notation for very small values
 * - Shows K/M/B suffixes for large numbers
 * - Conditionally displays tooltip with full precision ONLY when exponential notation is used
 * - Avoids unnecessary tooltips for normal values
 * 
 * @example
 * // Very small value - shows tooltip with full precision
 * <ValueDisplay value={0.000000123} />
 * // Displays: "1.23e-7" with tooltip "0.000000123"
 * 
 * @example
 * // Normal value - no tooltip
 * <ValueDisplay value={123.456} />
 * // Displays: "123.456" (no tooltip)
 * 
 * @example
 * // Large value - no tooltip
 * <ValueDisplay value={1234567} />
 * // Displays: "1.23M" (no tooltip)
 * 
 * @example
 * // Use for prices
 * <ValueDisplay value={0.00000089} />
 * // Displays: "8.90e-7" with tooltip
 * 
 * @example
 * // Use for fees
 * <ValueDisplay value={0.000123} />
 * // Displays: "0.000123" (no tooltip since > 0.0001)
 */
export const ValueDisplay: React.FC<ValueDisplayProps> = ({
  value,
  currency,
  options,
  className,
  style,
}) => {
  // Handle null/undefined values
  if (value === null || value === undefined) {
    return <span className={className} style={style}>-</span>;
  }

  // Format based on whether currency is provided
  const formattedValue = currency
    ? formatQuantityWithCurrency(value, currency, options)
    : formatQuantity(value, options);

  // Show tooltip when display is truncated: exponential, K/M/B suffixes, or reduced decimals
  const fullPrecisionValue = currency
    ? formatQuantityWithCurrency(value, currency, { ...options, forceFullPrecision: true })
    : formatQuantityFullPrecision(value);

  const showTooltip = shouldShowTooltip(value, options) || formattedValue !== fullPrecisionValue;

  // If tooltip should be shown, wrap in Tooltip component
  if (showTooltip) {
    return (
      <Tooltip content={fullPrecisionValue} openDelay={200} closeDelay={100}>
        <span className={className} style={{ ...style, cursor: 'help', textDecoration: 'underline dotted' }}>
          {formattedValue}
        </span>
      </Tooltip>
    );
  }

  // Otherwise, just display the formatted value
  return (
    <span className={className} style={style}>
      {formattedValue}
    </span>
  );
};

export default ValueDisplay;
