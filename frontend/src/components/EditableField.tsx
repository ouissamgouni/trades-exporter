import React, { useState, useRef, useEffect } from 'react';
import { Box, Flex, Input, NativeSelect, Switch, Text } from '@chakra-ui/react';
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
            <Flex justify="space-between" py={0.5} gap={2} align="center">
                <Text fontSize={fontSize} color="gray.500" flexShrink={0}>{label}</Text>
                <Flex align="center" gap={1}>
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                    <Switch.Root
                        size="sm"
                        checked={value === 'true'}
                        onCheckedChange={async () => {
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
                        disabled={!editable || isSaving}
                    >
                        <Switch.HiddenInput />
                        <Switch.Control />
                    </Switch.Root>
                </Flex>
            </Flex>
        );
    }

    // ---- View mode ----
    if (!isEditing) {
        return (
            <Flex
                justify="space-between"
                py={0.5}
                gap={2}
                align="center"
                onClick={editable ? startEditing : undefined}
                cursor={editable ? 'pointer' : 'default'}
                px={1}
                mx={-1}
                borderWidth="1px"
                borderColor="transparent"
                borderRadius="sm"
                transition="all 0.1s"
                _hover={editable ? { borderColor: 'blue.200', bg: 'blue.50' } : undefined}
                css={editable ? { '&:hover .ef-pencil': { opacity: 0.5 } } : undefined}
            >
                <Text fontSize={fontSize} color="gray.500" flexShrink={0}>{label}</Text>
                <Flex
                    align="center"
                    gap={1}
                    minW={0}
                >
                    {editable && (
                        <Box
                            className="ef-pencil"
                            opacity={0}
                            transition="opacity 0.15s"
                            flexShrink={0}
                            color="blue.400"
                        >
                            <FiEdit2 size={9} />
                        </Box>
                    )}
                    {copyable && value ? (
                        <Flex align="center" gap={1}>
                            <Box
                                as="span"
                                fontSize={fontSize}
                                color={alert ? 'orange.500' : muted ? 'gray.400' : 'gray.700'}
                                fontFamily="mono"
                                textAlign="right"
                                css={{ wordBreak: 'break-all', userSelect: 'text' }}
                            >
                                {displayValue ?? (truncateLength && value.length > truncateLength
                                    ? `${value.slice(0, truncateLength)}…`
                                    : value)}
                            </Box>
                            <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                <Box
                                    as="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(value);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    }}
                                    opacity={0.5}
                                    color={copied ? 'green.500' : 'gray.400'}
                                    _hover={{ color: copied ? 'green.500' : 'blue.500' }}
                                    cursor="pointer"
                                    flexShrink={0}
                                >
                                    {copied ? <FiCheck size={9} /> : <FiCopy size={9} />}
                                </Box>
                            </Tooltip>
                        </Flex>
                    ) : (
                        <Box
                            as="span"
                            fontSize={fontSize}
                            color={alert ? 'orange.500' : muted ? 'gray.400' : 'gray.700'}
                            fontFamily="mono"
                            textAlign="right"
                            css={{ wordBreak: 'break-all', userSelect: 'text' }}
                        >
                            {displayValue ?? (value || '-')}
                        </Box>
                    )}
                </Flex>
            </Flex>
        );
    }

    // ---- Edit mode ----
    const borderColor = hasError ? 'red.500' : 'blue.300';

    // Custom renderer
    if (renderEdit) {
        return (
            <Flex
                justify="space-between"
                py={0.5}
                gap={2}
                align="center"
                ref={editContainerRef}
            >
                <Text fontSize={fontSize} color="blue.600" fontWeight="medium" flexShrink={0}>{label}</Text>
                <Box flex="1" maxW="65%">
                    {isSaving ? (
                        <Flex justify="flex-end">
                            <LuLoader size={12} className="animate-spin" />
                        </Flex>
                    ) : (
                        renderEdit(localValue, setLocalValue, handleSave, handleCancel)
                    )}
                </Box>
            </Flex>
        );
    }

    // Select type
    if (type === 'select' && options) {
        return (
            <Flex justify="space-between" py={0.5} gap={2} align="center">
                <Text fontSize={fontSize} color="blue.600" fontWeight="medium" flexShrink={0}>{label}</Text>
                <Box flex="1" maxW="65%">
                    {isSaving ? (
                        <Flex justify="flex-end">
                            <LuLoader size={12} className="animate-spin" />
                        </Flex>
                    ) : (
                        <NativeSelect.Root size="xs">
                            <NativeSelect.Field
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
                                fontSize="10px"
                                borderColor={borderColor}
                            >
                                {options.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    )}
                </Box>
            </Flex>
        );
    }

    // Text / number / datetime input
    return (
        <Flex justify="space-between" py={0.5} gap={2} align="center">
            <Text fontSize={fontSize} color="blue.600" fontWeight="medium" flexShrink={0}>{label}</Text>
            <Box flex="1" maxW="65%">
                {isSaving ? (
                    <Flex justify="flex-end">
                        <LuLoader size={12} className="animate-spin" />
                    </Flex>
                ) : (
                    <Input
                        ref={inputRef as React.RefObject<HTMLInputElement>}
                        size="xs"
                        type={type === 'datetime' ? 'datetime-local' : type}
                        step={type === 'number' ? 'any' : undefined}
                        value={localValue}
                        onChange={(e) => setLocalValue(e.target.value)}
                        onBlur={handleSave}
                        onKeyDown={handleKeyDown}
                        fontSize="10px"
                        borderColor={borderColor}
                        fontFamily="mono"
                    />
                )}
            </Box>
        </Flex>
    );
};

export default EditableField;
