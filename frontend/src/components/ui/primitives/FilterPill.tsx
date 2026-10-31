import * as React from 'react';
import { cn } from '../../../lib/cn';

/**
 * Standardized filter pill (chip) used for all filter-toggle UIs across the app.
 * Design reference: the compact chips originally in `AccountsManagement.tsx`.
 * Square corners by design system.
 */
export type FilterPillColor =
    | 'blue'
    | 'cyan'
    | 'purple'
    | 'green'
    | 'teal'
    | 'orange'
    | 'gray'
    | 'red';

// Literal class maps (Tailwind JIT needs full class strings — no interpolation).
const PILL_COLORS: Record<FilterPillColor, { active: string; inactive: string }> = {
    blue: { active: 'bg-blue-600 text-white border border-blue-600', inactive: 'border border-blue-300 text-blue-700 hover:bg-blue-50' },
    cyan: { active: 'bg-cyan-600 text-white border border-cyan-600', inactive: 'border border-cyan-300 text-cyan-700 hover:bg-cyan-50' },
    purple: { active: 'bg-purple-600 text-white border border-purple-600', inactive: 'border border-purple-300 text-purple-700 hover:bg-purple-50' },
    green: { active: 'bg-green-600 text-white border border-green-600', inactive: 'border border-green-300 text-green-700 hover:bg-green-50' },
    teal: { active: 'bg-teal-600 text-white border border-teal-600', inactive: 'border border-teal-300 text-teal-700 hover:bg-teal-50' },
    orange: { active: 'bg-orange-600 text-white border border-orange-600', inactive: 'border border-orange-300 text-orange-700 hover:bg-orange-50' },
    gray: { active: 'bg-slate-700 text-white border border-slate-700', inactive: 'border border-slate-300 text-slate-700 hover:bg-slate-50' },
    red: { active: 'bg-red-600 text-white border border-red-600', inactive: 'border border-red-300 text-red-700 hover:bg-red-50' },
};

const FOCUS_RING =
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1';

export interface FilterPillProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'color'> {
    active?: boolean;
    color?: FilterPillColor;
    /** Optional trailing count badge value. */
    count?: number | string;
}

export const FilterPill = React.forwardRef<HTMLButtonElement, FilterPillProps>(function FilterPill(
    { className, active = false, color = 'blue', count, children, type = 'button', ...rest },
    ref,
) {
    const c = PILL_COLORS[color];
    return (
        <button
            ref={ref}
            type={type}
            aria-pressed={active}
            className={cn(
                'inline-flex shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap px-2 py-0.5 text-xs font-medium transition-colors',
                FOCUS_RING,
                active ? c.active : c.inactive,
                className,
            )}
            {...rest}
        >
            {children}
            {count !== undefined && (
                <span
                    className={cn(
                        'ml-0.5 inline-flex min-w-[1rem] items-center justify-center px-1 text-[10px] leading-none',
                        active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-600',
                    )}
                >
                    {count}
                </span>
            )}
        </button>
    );
});

export interface FilterPillGroupProps extends React.ComponentPropsWithoutRef<'div'> {
    /** When true (default), pills scroll horizontally on mobile and wrap on >=sm. */
    scrollOnMobile?: boolean;
}

/**
 * Container for a row of `FilterPill`s. On mobile the row is horizontally
 * scrollable (no wrap); from the `sm` breakpoint up it wraps normally.
 */
export const FilterPillGroup = React.forwardRef<HTMLDivElement, FilterPillGroupProps>(
    function FilterPillGroup({ className, scrollOnMobile = true, children, ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    'flex items-center gap-2',
                    scrollOnMobile
                        ? 'flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible'
                        : 'flex-wrap',
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    },
);
