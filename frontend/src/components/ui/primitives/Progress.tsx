import * as React from 'react';
import { cn } from '../../../lib/cn';

export type ProgressColorScheme = 'blue' | 'orange' | 'red' | 'green';
export type ProgressSize = 'sm' | 'md';

export interface ProgressProps {
    value: number;
    max?: number;
    size?: ProgressSize;
    colorScheme?: ProgressColorScheme;
    className?: string;
}

const COLORS: Record<ProgressColorScheme, string> = {
    blue: 'bg-blue-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
    green: 'bg-green-500',
};

const SIZES: Record<ProgressSize, string> = {
    sm: 'h-1.5',
    md: 'h-2',
};

/** Simple horizontal progress bar. */
export const Progress: React.FC<ProgressProps> = ({ value, max = 100, size = 'md', colorScheme = 'blue', className }) => {
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    return (
        <div className={cn('w-full overflow-hidden bg-slate-200', SIZES[size], className)}>
            <div className={cn('h-full transition-all', COLORS[colorScheme])} style={{ width: `${pct}%` }} />
        </div>
    );
};
