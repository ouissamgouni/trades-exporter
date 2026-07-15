import * as React from 'react';
import { cn } from '../../../lib/cn';

/** Inline text primitive (renders a `span`). */
export const Text = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<'span'>>(
    function Text({ className, ...rest }, ref) {
        return <span ref={ref} className={cn(className)} {...rest} />;
    },
);

type HeadingProps = React.ComponentPropsWithoutRef<'h2'> & {
    as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
};

/** Section heading primitive. Defaults to an `h3` with semibold weight. */
export const Heading = React.forwardRef<HTMLHeadingElement, HeadingProps>(function Heading(
    { className, as: Tag = 'h3', ...rest },
    ref,
) {
    return <Tag ref={ref} className={cn('font-semibold leading-tight', className)} {...rest} />;
});
