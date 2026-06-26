import * as React from 'react';
import { cn } from '../../../lib/cn';

/**
 * Box — the most basic layout primitive. A `div` with a `className` passthrough.
 * Replaces Chakra's `Box` during the Tailwind migration.
 */
export const Box = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    function Box({ className, ...rest }, ref) {
        return <div ref={ref} className={cn(className)} {...rest} />;
    },
);
