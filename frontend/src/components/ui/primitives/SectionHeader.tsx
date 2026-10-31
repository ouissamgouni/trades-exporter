import * as React from 'react';
import { cn } from '../../../lib/cn';

/**
 * Standardized responsive header rows.
 *
 * Layout: title (+ optional description) on the left, actions on the right.
 * On mobile the actions stack BELOW the title/description (they never sit
 * squished to the right of a smashed description). From `sm` up, actions sit
 * inline on the right.
 *
 * Typography (per design system):
 * - PageHeader title: text-base semibold
 * - SectionHeader title: text-sm semibold
 * - descriptions: text-xs muted
 */

interface HeaderProps {
    title: React.ReactNode;
    description?: React.ReactNode;
    /** Right-aligned action buttons/controls. */
    actions?: React.ReactNode;
    /** Optional leading node (icon, badge) rendered before the title. */
    leading?: React.ReactNode;
    className?: string;
    /** Heading level for the title element. Defaults to h2 (page) / h3 (section). */
    as?: 'h1' | 'h2' | 'h3' | 'h4';
    children?: React.ReactNode;
}

const HeaderShell: React.FC<HeaderProps & { titleClass: string; defaultAs: HeaderProps['as'] }> = ({
    title,
    description,
    actions,
    leading,
    className,
    as,
    titleClass,
    defaultAs,
    children,
}) => {
    const Tag = (as ?? defaultAs) as keyof React.JSX.IntrinsicElements;
    return (
        <div
            className={cn(
                'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
                className,
            )}
        >
            <div className="flex min-w-0 items-center gap-2">
                {leading}
                <div className="min-w-0">
                    <Tag className={cn('truncate leading-tight', titleClass)}>{title}</Tag>
                    {description && (
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
                    )}
                    {children}
                </div>
            </div>
            {actions && (
                <div className="flex flex-shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                    {actions}
                </div>
            )}
        </div>
    );
};

/** Top-level page header (title text-base). */
export const PageHeader: React.FC<HeaderProps> = (props) => (
    <HeaderShell
        {...props}
        defaultAs="h2"
        titleClass="text-base font-semibold text-slate-800 dark:text-slate-100"
    />
);

/** Section header (title text-sm). */
export const SectionHeader: React.FC<HeaderProps> = (props) => (
    <HeaderShell
        {...props}
        defaultAs="h3"
        titleClass="text-sm font-semibold text-slate-800 dark:text-slate-100"
    />
);
