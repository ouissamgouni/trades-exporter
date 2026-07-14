import React, { useState, useRef, useEffect } from 'react';
import { FiEdit2, FiCopy, FiCheck } from 'react-icons/fi';
import { LuLoader } from 'react-icons/lu';
import { Tooltip } from './ui/tooltip';

// ============================================================================
// Types
// ============================================================================

export interface SelectOption {
    label: string;
    value: string;
}

export interface EditableFieldProps {
    /** Label displayed on the left */
    label: string;
    /** Current raw value (string representation) */
    value: string;
    /** Displayed value node when not editing (defaults to value text) */
    displayValue?: React.ReactNode;
    /** Called with the new value when user saves. Should throw on error. */
    onSave: (newValue: string) => Promise<void>;
    /** Field input type */
    type?: 'text' | 'number' | 'select' | 'datetime' | 'checkbox';
    /** Options for select type */
    options?: SelectOption[];
    /** Custom edit renderer (overrides type-based input) */
    renderEdit?: (
        value: string,
        onChange: (v: string) => void,
        onSave: () => void,
        onCancel: () => void,
    ) => React.ReactNode;
    /** Whether this field is editable (default: true) */
    editable?: boolean;
    /** Show copy button for this field */
    copyable?: boolean;
    /** Truncate length for copyable values */
    truncateLength?: number;
    /** Dim value styling */
    muted?: boolean;
    /** Show alert styling */
    alert?: boolean;
    /** Font size (default: "10px") */
    fontSize?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * EditableField - An InfoRow-style label/value pair that toggles to inline edit on click.
 *
 * View mode: shows label + value (or displayValue) with pencil icon on hover.
 * Edit mode: shows label + input with Enter to save, Escape to cancel.
 * Handles saving state with spinner, error flash, and auto-revert.
 */
export const EditableField: React.FC<EditableFieldProps> = ({
    label,
    value,
    displayValue,
    onSave,
    type = 'text',
    options,
    renderEdit,
    editable = true,
    copyable = false,
    truncateLength,
    muted = false,
    alert = false,
    fontSize = '10px',
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [localValue, setLocalValue] = useState(value);
    const [isSaving, setIsSaving] = useState(false);
    const [hasError, setHasError] = useState(false);
    const [copied, setCopied] = useState(false);
    const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const editContainerRef = useRef<HTMLDivElement>(null);

    // Sync local value when external value changes
    useEffect(() => {
        if (!isEditing) {
            setLocalValue(value);
        }
    }, [value, isEditing]);

    // Focus input when entering edit mode
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            if ('select' in inputRef.current && type !== 'select') {
                (inputRef.current as HTMLInputElement).select();
            }
        }
    }, [isEditing, type]);

    // Click-outside detection for custom renderEdit (close on click outside)
    useEffect(() => {
        if (!isEditing || !renderEdit) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (editContainerRef.current && !editContainerRef.current.contains(e.target as Node)) {
                handleCancel();
            }
        };
        // Use a small delay to avoid immediately capturing the click that opened edit mode
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 100);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isEditing, renderEdit]);

    // Global Escape key listener for renderEdit mode (fires even when selector input has focus)
    useEffect(() => {
        if (!isEditing || !renderEdit) return;
        const handleGlobalEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleCancel();
            }
        };
        document.addEventListener('keydown', handleGlobalEscape, true);
        return () => {
            document.removeEventListener('keydown', handleGlobalEscape, true);
        };
    }, [isEditing, renderEdit]);

    const handleSave = async () => {
        if (localValue === value) {
            setIsEditing(false);
            return;
        }

        setIsSaving(true);
        setHasError(false);
        try {
            await onSave(localValue);
            setIsEditing(false);
        } catch {
            setHasError(true);
            // Revert after brief flash
            setTimeout(() => {
                setLocalValue(value);
                setHasError(false);
            }, 1500);
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancel = () => {
        setLocalValue(value);
        setIsEditing(false);
        setHasError(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    };

    const startEditing = () => {
        if (!editable || isSaving) return;
        setLocalValue(value);
        setIsEditing(true);
    };

    // ---- Checkbox type: render as toggle, no edit mode needed ----
    if (type === 'checkbox') {
        return (
            <div className="flex items-center justify-between gap-2 py-0.5">
                <span className="shrink-0 text-slate-500" style={{ fontSize }}>{label}</span>
                <div className="flex items-center gap-1">
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                    <button
                        type="button"
                        role="switch"
                        aria-checked={value === 'true'}
                        disabled={!editable || isSaving}
                        onClick={async () => {
                            if (!editable || isSaving) return;
                            const newVal = value === 'true' ? 'false' : 'true';
                            setIsSaving(true);
                            try {
                                await onSave(newVal);
                            } catch {
                                // revert
                            } finally {
                                setIsSaving(false);
                            }
                        }}
                        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${value === 'true' ? 'bg-blue-500' : 'bg-slate-300'} ${(!editable || isSaving) ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                    >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${value === 'true' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                    </button>
                </div>
            </div>
        );
    }

    // ---- View mode ----
    if (!isEditing) {
        return (
            <div
                className={`group -mx-1 flex items-center justify-between gap-2 border border-transparent px-1 py-0.5 transition-all ${editable ? 'cursor-pointer hover:border-blue-200 hover:bg-blue-50' : 'cursor-default'}`}
                onClick={editable ? startEditing : undefined}
            >
                <span className="shrink-0 text-slate-500" style={{ fontSize }}>{label}</span>
                <div className="flex min-w-0 items-center gap-1">
                    {editable && (
                        <span className="shrink-0 text-blue-400 opacity-0 transition-opacity group-hover:opacity-50">
                            <FiEdit2 size={9} />
                        </span>
                    )}
                    {copyable && value ? (
                        <div className="flex items-center gap-1">
                            <span
                                className={`break-all text-right font-mono ${alert ? 'text-orange-500' : muted ? 'text-slate-400' : 'text-slate-700'}`}
                                style={{ fontSize, userSelect: 'text' }}
                            >
                                {displayValue ?? (truncateLength && value.length > truncateLength
                                    ? `${value.slice(0, truncateLength)}…`
                                    : value)}
                            </span>
                            <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                <button
                                    type="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(value);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    }}
                                    className={`shrink-0 cursor-pointer opacity-50 ${copied ? 'text-green-500 hover:text-green-500' : 'text-slate-400 hover:text-blue-500'}`}
                                >
                                    {copied ? <FiCheck size={9} /> : <FiCopy size={9} />}
                                </button>
                            </Tooltip>
                        </div>
                    ) : (
                        <span
                            className={`break-all text-right font-mono ${alert ? 'text-orange-500' : muted ? 'text-slate-400' : 'text-slate-700'}`}
                            style={{ fontSize, userSelect: 'text' }}
                        >
                            {displayValue ?? (value || '-')}
                        </span>
                    )}
                </div>
            </div>
        );
    }

    // ---- Edit mode ----
    const inputBorderClass = hasError ? 'border-red-500' : 'border-blue-300';

    // Custom renderer
    if (renderEdit) {
        return (
            <div className="flex items-center justify-between gap-2 py-0.5" ref={editContainerRef}>
                <span className="shrink-0 font-medium text-blue-600" style={{ fontSize }}>{label}</span>
                <div className="max-w-[65%] flex-1">
                    {isSaving ? (
                        <div className="flex justify-end">
                            <LuLoader size={12} className="animate-spin" />
                        </div>
                    ) : (
                        renderEdit(localValue, setLocalValue, handleSave, handleCancel)
                    )}
                </div>
            </div>
        );
    }

    // Select type
    if (type === 'select' && options) {
        return (
            <div className="flex items-center justify-between gap-2 py-0.5">
                <span className="shrink-0 font-medium text-blue-600" style={{ fontSize }}>{label}</span>
                <div className="max-w-[65%] flex-1">
                    {isSaving ? (
                        <div className="flex justify-end">
                            <LuLoader size={12} className="animate-spin" />
                        </div>
                    ) : (
                        <select
                            ref={inputRef as React.RefObject<HTMLSelectElement>}
                            value={localValue}
                            onChange={(e) => {
                                setLocalValue(e.target.value);
                                // Auto-save on select change
                                const newVal = e.target.value;
                                setLocalValue(newVal);
                                // We need to save after state update
                                setTimeout(async () => {
                                    setIsSaving(true);
                                    try {
                                        await onSave(newVal);
                                        setIsEditing(false);
                                    } catch {
                                        setHasError(true);
                                        setTimeout(() => {
                                            setLocalValue(value);
                                            setHasError(false);
                                        }, 1500);
                                    } finally {
                                        setIsSaving(false);
                                    }
                                }, 0);
                            }}
                            onBlur={handleCancel}
                            onKeyDown={handleKeyDown}
                            className={`w-full border bg-white px-1 py-0.5 text-[10px] outline-none focus:border-blue-500 ${inputBorderClass}`}
                        >
                            {options.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    )}
                </div>
            </div>
        );
    }

    // Text / number / datetime input
    return (
        <div className="flex items-center justify-between gap-2 py-0.5">
            <span className="shrink-0 font-medium text-blue-600" style={{ fontSize }}>{label}</span>
            <div className="max-w-[65%] flex-1">
                {isSaving ? (
                    <div className="flex justify-end">
                        <LuLoader size={12} className="animate-spin" />
                    </div>
                ) : (
                    <input
                        ref={inputRef as React.RefObject<HTMLInputElement>}
                        type={type === 'datetime' ? 'datetime-local' : type}
                        step={type === 'number' ? 'any' : undefined}
                        value={localValue}
                        onChange={(e) => setLocalValue(e.target.value)}
                        onBlur={handleSave}
                        onKeyDown={handleKeyDown}
                        className={`w-full border bg-white px-1 py-0.5 font-mono text-[10px] outline-none focus:border-blue-500 ${inputBorderClass}`}
                    />
                )}
            </div>
        </div>
    );
};

export default EditableField;
