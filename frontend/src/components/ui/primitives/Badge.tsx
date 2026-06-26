import * as React from 'react';
import { cn } from '../../../lib/cn';

export type BadgeColorScheme = 'gray' | 'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'orange';

export interface BadgeProps extends React.ComponentPropsWithoutRef<'span'> {
    colorScheme?: BadgeColorScheme;
}

// Square corners by design system: no rounded utilities.
const COLORS: Record<BadgeColorScheme, string> = {
    gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200',
    green: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-200',
    red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200',
    purple: 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-200',
    orange: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-200',
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
    { className, colorScheme = 'gray', ...rest },
    ref,
) {
    return (
        <span
            ref={ref}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium leading-tight',
                COLORS[colorScheme],
                className,
            )}
            {...rest}
        />
    );
});
