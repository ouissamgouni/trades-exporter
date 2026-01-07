/**
 * Centralized date utility functions for consistent date handling across the application.
 * 
 * DESIGN DECISIONS:
 * - All dates are stored in the database as UTC datetime objects
 * - The backend returns dates as ISO 8601 strings (e.g., "2024-01-15T10:30:00Z" or "2024-01-15T10:30:00+00:00")
 * - The frontend displays dates in the user's local timezone
 * - When editing dates, we use datetime-local inputs which work in local time
 * - When sending dates back to the API, we convert local time to UTC ISO string
 * 
 * This module provides a single source of truth for:
 * - Parsing dates from the API (UTC strings or Unix timestamps)
 * - Formatting dates for display (in local timezone)
 * - Converting user input to API format (local -> UTC ISO)
 */

/**
 * Parse a date value from the API (can be ISO string, Unix timestamp in seconds, or Date object)
 * Always returns a Date object representing the correct moment in time.
 */
export function parseApiDate(value: string | number | Date | null | undefined): Date | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'number') {
        // Unix timestamp in seconds (multiply by 1000 for milliseconds)
        // Check if it's already in milliseconds (timestamps after year 2001 in seconds are < 10^10)
        const timestamp = value < 10000000000 ? value * 1000 : value;
        const date = new Date(timestamp);
        return isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === 'string') {
        // ISO 8601 string (e.g., "2024-01-15T10:30:00Z" or "2024-01-15T10:30:00+00:00")
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date;
    }

    return null;
}

// ============================================================================
// Display Formatting Functions (UTC -> Local Display)
// ============================================================================

/**
 * Format a date for compact display (MM/DD HH:mm)
 * Used in transaction tables where space is limited.
 */
export function formatDateTimeCompact(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');

    return `${month}/${day} ${hours}:${mins}`;
}

/**
 * Format a date for display (short date only: MM/DD or Jan 15)
 */
export function formatDateShort(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a date for display (MM/DD format)
 */
export function formatDateNumeric(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${month}/${day}`;
}

/**
 * Format time only for display (HH:mm)
 */
export function formatTimeShort(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '';

    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date using the browser's locale settings (full date)
 */
export function formatDateLocale(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    return date.toLocaleDateString();
}

/**
 * Format a date and time using the browser's locale settings
 */
export function formatDateTimeLocale(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    return date.toLocaleString();
}

/**
 * Format time only using the browser's locale settings
 */
export function formatTimeLocale(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    return date.toLocaleTimeString();
}

// ============================================================================
// Input Conversion Functions (Local Input <-> API Format)
// ============================================================================

/**
 * Convert a Date object to a string suitable for datetime-local input.
 * datetime-local inputs work in local time, so we use local components.
 * Format: "YYYY-MM-DDTHH:mm"
 */
export function toDateTimeLocalString(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '';

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Convert a Date object to a string suitable for date input.
 * Format: "YYYY-MM-DD"
 */
export function toDateInputString(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '';

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

/**
 * Convert a datetime-local input value to an ISO string for API submission.
 * The input value is in local time, and we convert it to UTC ISO string.
 * 
 * Input format: "YYYY-MM-DDTHH:mm" (local time)
 * Output format: "YYYY-MM-DDTHH:mm:ss.sssZ" (UTC ISO string)
 */
export function dateTimeLocalToISO(localDateTimeStr: string): string {
    if (!localDateTimeStr) return '';

    // The datetime-local input provides a local time string
    // new Date() interprets this as local time
    const date = new Date(localDateTimeStr);
    if (isNaN(date.getTime())) return '';

    return date.toISOString();
}

/**
 * Convert a date input value to an ISO string for API submission.
 * For date-only inputs, we can specify the time component.
 * 
 * Input format: "YYYY-MM-DD"
 * Output format: "YYYY-MM-DDTHH:mm:ss.sssZ" (UTC ISO string)
 * 
 * @param localDateStr - The date string from a date input
 * @param timeOfDay - 'start' for 00:00:00, 'end' for 23:59:59
 */
export function dateInputToISO(localDateStr: string, timeOfDay: 'start' | 'end' = 'start'): string {
    if (!localDateStr) return '';

    const timeSuffix = timeOfDay === 'start' ? 'T00:00:00' : 'T23:59:59';
    const date = new Date(localDateStr + timeSuffix);
    if (isNaN(date.getTime())) return '';

    return date.toISOString();
}

// ============================================================================
// Date Range Utilities (for filters)
// ============================================================================

/**
 * Get a date range for filtering based on preset periods.
 * Returns dates as datetime-local strings for filter inputs.
 */
export function getDateRangePreset(months: number): { from: string; to: string } {
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setMonth(fromDate.getMonth() - months);

    return {
        from: `${toDateInputString(fromDate)}T00:00`,
        to: `${toDateInputString(today)}T23:59`,
    };
}

/**
 * Get the date range from a list of dates (for displaying bundle date ranges).
 * Returns formatted date range string like "01/15" or "01/15 - 02/20".
 */
export function getDateRangeDisplay(dates: (string | number | Date)[]): string {
    if (!dates || dates.length === 0) return '-';

    const timestamps = dates
        .map(d => parseApiDate(d)?.getTime())
        .filter((t): t is number => t !== null && t !== undefined && !isNaN(t));

    if (timestamps.length === 0) return '-';

    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const minStr = formatDateNumeric(minDate);
    const maxStr = formatDateNumeric(maxDate);

    return minStr === maxStr ? minStr : `${minStr} - ${maxStr}`;
}

// ============================================================================
// Date Comparison Utilities
// ============================================================================

/**
 * Check if two dates are the same day (ignoring time).
 */
export function isSameDay(
    date1: string | number | Date | null | undefined,
    date2: string | number | Date | null | undefined
): boolean {
    const d1 = parseApiDate(date1);
    const d2 = parseApiDate(date2);

    if (!d1 || !d2) return false;

    return (
        d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate()
    );
}

/**
 * Check if a date is within a range (inclusive).
 */
export function isDateInRange(
    date: string | number | Date | null | undefined,
    rangeStart: string | number | Date | null | undefined,
    rangeEnd: string | number | Date | null | undefined
): boolean {
    const d = parseApiDate(date);
    const start = parseApiDate(rangeStart);
    const end = parseApiDate(rangeEnd);

    if (!d) return false;

    const inStart = start ? d.getTime() >= start.getTime() : true;
    const inEnd = end ? d.getTime() <= end.getTime() : true;

    return inStart && inEnd;
}

// ============================================================================
// Type exports for consistency
// ============================================================================

/**
 * A date value as received from the API.
 * Can be ISO string (common), Unix timestamp in seconds (legacy), or already a Date.
 */
export type ApiDateValue = string | number | Date | null | undefined;
