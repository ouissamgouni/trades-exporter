import * as React from 'react';
import { cn } from '../../../lib/cn';

/**
 * Wraps a wide `<table>` so it scrolls horizontally WITHIN its container/card
 * on small screens instead of overflowing the page. Use around any table that
 * can exceed the viewport width on mobile.
 *
 * The inner element uses `overflow-x-auto`; the table should keep its natural
 * min-width (e.g. `min-w-[720px]`) so columns don't collapse.
 */
export interface ResponsiveTableProps extends React.ComponentPropsWithoutRef<'div'> {
    children: React.ReactNode;
}

export const ResponsiveTable = React.forwardRef<HTMLDivElement, ResponsiveTableProps>(
    function ResponsiveTable({ className, children, ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    'w-full max-w-full overflow-x-auto [scrollbar-width:thin]',
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    },
);
