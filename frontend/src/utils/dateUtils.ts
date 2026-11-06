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
        // If no timezone marker is present, treat as UTC (backend stores all datetimes in UTC)
        let normalized = value;
        if (!value.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(value)) {
            normalized = value + 'Z';
        }
        const date = new Date(normalized);
        return isNaN(date.getTime()) ? null : date;
    }

    return null;
}

// ============================================================================
// Display Formatting Functions (UTC -> Local Display)
// ============================================================================

/**
 * Format a date for compact display (MM/DD/YY HH:mm)
 * Used in transaction tables where space is limited.
 */
export function formatDateTimeCompact(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return '-';

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');

    return `${month}/${day}/${year} ${hours}:${mins}`;
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

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Transaction row date: "14:32" (time mode, used under a day header),
 * "5 Nov 14:32" (current year) or "5 Nov 2024 14:32".
 */
export function formatTxDateTime(
    value: string | number | Date | null | undefined,
    mode: 'full' | 'time' = 'full',
    now: Date = new Date(),
): string {
    const date = parseApiDate(value);
    if (!date) return '-';
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (mode === 'time') return time;
    const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
    return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}${year} ${time}`;
}

/** Parse a local "YYYY-MM-DD" period key into a local Date at midnight. */
function parsePeriodStart(periodStart: string): Date {
    const [y, m, d] = periodStart.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** Month group label: "November" (current year) or "Nov 2024". */
export function formatMonthLabel(periodStart: string, now: Date = new Date()): string {
    const date = parsePeriodStart(periodStart);
    if (date.getFullYear() === now.getFullYear()) return MONTHS_LONG[date.getMonth()];
    return `${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** Day group label: "Today", "Yesterday", or "Wed 5". */
export function formatDayLabel(periodStart: string, now: Date = new Date()): string {
    const date = parsePeriodStart(periodStart);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((today.getTime() - date.getTime()) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()}`;
}

/** Browser IANA timezone (falls back to UTC). */
export function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * Convert a local filter value ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm") to the naive-UTC
 * ISO string the backend compares against. Values already carrying a zone are passed through.
 */
export function localFilterToUtcNaive(value: string, edge: 'start' | 'end'): string {
    if (!value) return '';
    if (value.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value)) return value;
    const hasTime = value.includes('T');
    const local = hasTime
        ? new Date(edge === 'end' && value.length === 16 ? `${value}:59.999` : value)
        : new Date(`${value}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`);
    if (isNaN(local.getTime())) return value;
    return local.toISOString().replace('Z', '');
}

/** Local "YYYY-MM-DD" for a Date. */
export function toLocalDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export type NamedDateRange = 'this_month' | 'last_30d' | 'ytd' | 'last_tax_year';

export const NAMED_DATE_RANGES: { id: NamedDateRange; label: string }[] = [
    { id: 'this_month', label: 'This month' },
    { id: 'last_30d', label: 'Last 30d' },
    { id: 'ytd', label: 'YTD' },
    { id: 'last_tax_year', label: 'Last tax year' },
];

/** Date-only local range for a preset; tax year = calendar year (FR). */
export function getNamedDateRange(id: NamedDateRange, now: Date = new Date()): { from: string; to: string } {
    const today = toLocalDateKey(now);
    switch (id) {
        case 'this_month':
            return { from: toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
        case 'last_30d':
            return { from: toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: today };
        case 'ytd':
            return { from: `${now.getFullYear()}-01-01`, to: today };
        case 'last_tax_year':
            return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
    }
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
 * Format a date/time as a human-friendly relative string (e.g. "5m ago", "2h ago", "3d ago").
 */
export function formatRelativeTime(value: string | number | Date | null | undefined): string {
    const date = parseApiDate(value);
    if (!date) return 'Never';
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60_000);
    const hrs = Math.floor(diffMs / 3_600_000);
    const days = Math.floor(diffMs / 86_400_000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
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
