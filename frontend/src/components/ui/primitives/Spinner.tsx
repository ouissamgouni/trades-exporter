import * as React from 'react';
import { cn } from '../../../lib/cn';

/** Circular loading spinner. `rounded-full` is an allowed exception (genuinely circular). */
export interface SpinnerProps extends React.ComponentPropsWithoutRef<'span'> {
    size?: 'xs' | 'sm' | 'md' | 'lg';
}

const SIZES: Record<NonNullable<SpinnerProps['size']>, string> = {
    xs: 'h-3 w-3 border-2',
    sm: 'h-4 w-4 border-2',
    md: 'h-6 w-6 border-2',
    lg: 'h-8 w-8 border-[3px]',
};

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
    function Spinner({ className, size = 'md', ...rest }, ref) {
        return (
            <span
                ref={ref}
                role="status"
                aria-label="Loading"
                className={cn(
                    'inline-block animate-spin rounded-full border-current border-t-transparent',
                    SIZES[size],
                    className,
                )}
                {...rest}
            />
        );
    },
);
