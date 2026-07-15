/**
 * Shared UI class-string tokens for a consistent look & feel across pages.
 *
 * These are plain Tailwind class strings (not components) so they compose with
 * `cn()` and stay fully static/greppable for the JIT scanner. Prefer these over
 * ad-hoc per-file styling for panels, section headings, and focus rings.
 *
 * Design system: square corners (no `rounded-*` except avatars / status dots).
 */

/** A surface panel: white card with a hairline border + subtle shadow. */
export const PANEL = 'border border-slate-200 bg-white shadow-sm';

/** A panel section body padding (responsive). */
export const PANEL_BODY = 'p-3 md:p-4';

/** Muted sub-surface used for nested/secondary blocks (e.g. card detail rows). */
export const SUBPANEL = 'border border-slate-200 bg-slate-50';

/** Section heading: small uppercase label used above groups of content. */
export const SECTION_LABEL =
    'text-[11px] font-semibold uppercase tracking-wide text-slate-500';

/** Section title: primary heading for a page section. */
export const SECTION_TITLE = 'text-base font-semibold text-slate-800';

/** Consistent keyboard focus ring for interactive elements that opt in. */
export const FOCUS_RING =
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1';

/** Horizontal scroll region for wide content (tables) on small screens. */
export const SCROLL_X = 'overflow-x-auto';

/** Sticky table header row. */
export const TABLE_HEAD =
    'sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500';

/** Left/right sticky column cell shadow so it separates from scrolled content. */
export const STICKY_COL_SHADOW_LEFT = 'shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]';
export const STICKY_COL_SHADOW_RIGHT = 'shadow-[-2px_0_4px_-2px_rgba(0,0,0,0.15)]';
