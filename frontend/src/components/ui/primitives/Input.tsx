import * as React from 'react';
import { cn } from '../../../lib/cn';

// Square corners by design system: no rounded utilities.
const FIELD_BASE =
    'w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 ' +
    'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed ' +
    'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(
    function Input({ className, ...rest }, ref) {
        return <input ref={ref} className={cn(FIELD_BASE, 'h-9', className)} {...rest} />;
    },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<'textarea'>>(
    function Textarea({ className, ...rest }, ref) {
        return <textarea ref={ref} className={cn(FIELD_BASE, 'py-2', className)} {...rest} />;
    },
);
