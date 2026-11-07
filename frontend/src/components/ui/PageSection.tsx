import React from 'react';
import { LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { cn } from '../../lib/cn';

interface PageSectionProps {
    icon?: React.ReactNode;
    title: React.ReactNode;
    /** Inline content right after the title (counts, view switches). */
    meta?: React.ReactNode;
    /** Right-aligned header actions. */
    actions?: React.ReactNode;
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    bodyClassName?: string;
    className?: string;
    children?: React.ReactNode;
}

/** Top-level page block (card with a header strip) so page areas read as distinct sections. */
export const PageSection: React.FC<PageSectionProps> = ({
    icon,
    title,
    meta,
    actions,
    collapsed = false,
    onToggleCollapsed,
    bodyClassName,
    className,
    children,
}) => {
    const heading = (
        <>
            {icon && <span className="text-slate-500">{icon}</span>}
            {title}
        </>
    );
    return (
        <section className={cn('border border-slate-200 bg-white shadow-sm', className)}>
            <header className={cn('flex min-h-[40px] flex-wrap items-center gap-x-3 gap-y-1 bg-slate-50 px-3 py-1.5', !collapsed && 'border-b border-slate-200')}>
                {onToggleCollapsed ? (
                    <button
                        type="button"
                        aria-expanded={!collapsed}
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800 hover:text-blue-600"
                        onClick={onToggleCollapsed}
                    >
                        {heading}
                        {collapsed ? <LuChevronDown size={14} /> : <LuChevronUp size={14} />}
                    </button>
                ) : (
                    <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800">{heading}</h3>
                )}
                {meta}
                {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
            </header>
            {!collapsed && <div className={bodyClassName}>{children}</div>}
        </section>
    );
};
