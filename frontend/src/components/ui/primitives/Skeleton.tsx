import * as React from 'react';
import { cn } from '../../../lib/cn';

export interface SkeletonProps extends React.ComponentPropsWithoutRef<'div'> {
    height?: string | number;
    width?: string | number;
}

/** Pulsing placeholder block shown while content is loading. */
export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
    { className, height, width, style, ...rest },
    ref,
) {
    return (
        <div
            ref={ref}
            className={cn('animate-pulse bg-slate-200 dark:bg-slate-700', className)}
            style={{ height, width, ...style }}
            {...rest}
        />
    );
});
