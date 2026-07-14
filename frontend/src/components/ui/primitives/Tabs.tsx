import * as React from 'react';
import { cn } from '../../../lib/cn';

interface TabsContextValue {
    value: string;
    setValue: (v: string) => void;
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
}

export const Tabs: React.FC<TabsProps> = ({ value, onValueChange, children, className }) => (
    <TabsContext.Provider value={{ value, setValue: onValueChange }}>
        <div className={className}>{children}</div>
    </TabsContext.Provider>
);

export interface TabsListProps {
    children: React.ReactNode;
    className?: string;
}

export const TabsList: React.FC<TabsListProps> = ({ children, className }) => (
    <div className={cn('flex items-center gap-1 border-b border-slate-200', className)}>{children}</div>
);

export interface TabsTriggerProps {
    value: string;
    children: React.ReactNode;
    className?: string;
}

export const TabsTrigger: React.FC<TabsTriggerProps> = ({ value, children, className }) => {
    const { value: active, setValue } = useTabsContext('TabsTrigger');
    const isActive = active === value;
    return (
        <button
            type="button"
            onClick={() => setValue(value)}
            className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                isActive
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
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
