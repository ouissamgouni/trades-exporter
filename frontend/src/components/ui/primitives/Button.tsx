import * as React from 'react';
import { cn } from '../../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'solid' | 'outline' | 'ghost' | 'subtle';
export type ButtonColorScheme = 'blue' | 'red' | 'green' | 'gray';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'color'> {
    variant?: ButtonVariant;
    colorScheme?: ButtonColorScheme;
    size?: ButtonSize;
    loading?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
}

const BASE =
    'inline-flex items-center justify-center gap-2 font-medium transition-colors select-none ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed';

const SIZES: Record<ButtonSize, string> = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-9 px-4 text-sm',
    lg: 'h-10 px-5 text-base',
};

// Square corners by design system: no rounded utilities.
const SOLID: Record<ButtonColorScheme, string> = {
    blue: 'bg-blue-500 text-white hover:bg-blue-600',
    red: 'bg-red-600 text-white hover:bg-red-700',
    green: 'bg-green-600 text-white hover:bg-green-700',
    gray: 'bg-slate-700 text-white hover:bg-slate-800',
};

const OUTLINE: Record<ButtonColorScheme, string> = {
    blue: 'border border-blue-500 bg-white text-blue-600 hover:bg-blue-50 dark:bg-transparent dark:hover:bg-blue-950',
    red: 'border border-red-300 bg-white text-red-600 hover:bg-red-50 dark:bg-transparent dark:hover:bg-red-950',
    green: 'border border-green-300 bg-white text-green-700 hover:bg-green-50 dark:bg-transparent dark:hover:bg-green-950',
    gray: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800',
};

const GHOST: Record<ButtonColorScheme, string> = {
    blue: 'bg-transparent text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950',
    red: 'bg-transparent text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
    green: 'bg-transparent text-green-700 hover:bg-green-50 dark:hover:bg-green-950',
    gray: 'bg-transparent text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
};

const SUBTLE: Record<ButtonColorScheme, string> = {
    blue: 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-950 dark:text-blue-200',
    red: 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-200',
    green: 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950 dark:text-green-200',
    gray: 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200',
};

const VARIANTS: Record<ButtonVariant, Record<ButtonColorScheme, string>> = {
    solid: SOLID,
    outline: OUTLINE,
    ghost: GHOST,
    subtle: SUBTLE,
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        className,
        variant = 'solid',
        colorScheme = 'blue',
        size = 'md',
        loading = false,
        leftIcon,
        rightIcon,
        disabled,
        children,
        type = 'button',
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            className={cn(BASE, SIZES[size], VARIANTS[variant][colorScheme], className)}
            {...rest}
        >
            {loading ? <Spinner size="sm" /> : leftIcon}
            {children}
            {!loading && rightIcon}
        </button>
    );
});
