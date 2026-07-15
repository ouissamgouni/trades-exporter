import * as React from 'react';
import { cn } from '../../../lib/cn';

export type TabsVariant = 'underline' | 'segment';

interface TabsContextValue {
    value: string;
    setValue: (v: string) => void;
    variant: TabsVariant;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
    const ctx = React.useContext(TabsContext);
    if (!ctx) throw new Error(`${component} must be used within <Tabs>`);
    return ctx;
}

export interface TabsProps {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
    className?: string;
    /** `underline` (default): primary page tabs. `segment`: compact subordinate sub-nav. */
    variant?: TabsVariant;
}

export const Tabs: React.FC<TabsProps> = ({ value, onValueChange, children, className, variant = 'underline' }) => (
    <TabsContext.Provider value={{ value, setValue: onValueChange, variant }}>
        <div className={className}>{children}</div>
    </TabsContext.Provider>
);

export interface TabsListProps {
    children: React.ReactNode;
    className?: string;
}

export const TabsList: React.FC<TabsListProps> = ({ children, className }) => {
    const { variant } = useTabsContext('TabsList');
    return (
        <div
            className={cn(
                variant === 'underline'
                    ? // Horizontally scrollable on small screens so long tab rows don't overflow.
                      'flex items-center gap-1 overflow-x-auto border-b border-slate-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                    : 'inline-flex flex-wrap items-center gap-0.5 border border-slate-200 bg-white p-0.5',
                className,
            )}
        >
            {children}
        </div>
    );
};

export interface TabsTriggerProps {
    value: string;
    children: React.ReactNode;
    className?: string;
}

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1';

export const TabsTrigger: React.FC<TabsTriggerProps> = ({ value, children, className }) => {
    const { value: active, setValue, variant } = useTabsContext('TabsTrigger');
    const isActive = active === value;
    return (
        <button
            type="button"
            onClick={() => setValue(value)}
            className={cn(
                FOCUS,
                variant === 'underline'
                    ? cn(
                          '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                              ? 'border-blue-500 text-blue-600'
                              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
                      )
                    : cn(
                          'whitespace-nowrap px-3 py-1 text-xs font-medium transition-colors',
                          isActive
                              ? 'bg-slate-100 text-slate-900'
                              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700',
                      ),
                className,
            )}
        >
            {children}
        </button>
    );
};

export interface TabsContentProps {
    value: string;
    children: React.ReactNode;
    className?: string;
}

export const TabsContent: React.FC<TabsContentProps> = ({ value, children, className }) => {
    const { value: active } = useTabsContext('TabsContent');
    if (active !== value) return null;
    return <div className={className}>{children}</div>;
};
