import * as React from 'react';
import { cn } from '../../../lib/cn';

/** Flex — a `div` with `display:flex`. Compose layout via Tailwind classes. */
export const Flex = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    function Flex({ className, ...rest }, ref) {
        return <div ref={ref} className={cn('flex', className)} {...rest} />;
    },
);

/** Horizontal stack: row, centered cross-axis, default gap. */
export const HStack = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    function HStack({ className, ...rest }, ref) {
        return <div ref={ref} className={cn('flex flex-row items-center gap-2', className)} {...rest} />;
    },
);

/** Vertical stack: column, default gap. */
export const VStack = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    function VStack({ className, ...rest }, ref) {
        return <div ref={ref} className={cn('flex flex-col gap-2', className)} {...rest} />;
    },
);

/** Generic stack (column by default), alias kept for parity with Chakra `Stack`. */
export const Stack = VStack;
