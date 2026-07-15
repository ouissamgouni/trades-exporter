/**
 * LinkableAccountField - Reusable component for account source↔linked-id display & editing.
 *
 * Encapsulates the repetitive pattern of:
 *   - Linked state: AccountBadge (shows source on hover), click to edit
 *   - Unlinked state: editable source text (orange ⚠) + AccountSuggestionBadges + AccountSelector
 *   - When source value is edited → clear linked ID + show new suggestions
 *   - When a suggestion is accepted → link the account
 *
 * Used for: account_id, from_account_id, to_account_id fields.
 */

import React, { useState, useRef, useEffect } from 'react';
import { FiEdit2, FiCopy, FiCheck, FiLink, FiPlusCircle } from 'react-icons/fi';
import { LuLoader } from 'react-icons/lu';
import { Account } from '../types';
import { AccountBadge } from './AccountBadge';
import { AccountSelector } from './AccountSelector';
import { AccountSuggestionBadges } from './AccountSuggestionBadges';
import { AccountSuggestion } from '../hooks/useAccountSuggestions';
import { Tooltip } from './ui/tooltip';

export interface LinkableAccountFieldProps {
    /** Label shown on the left */
    label: string;
    /** Raw source value (address/label) */
    sourceValue?: string | null;
    /** Linked account ID */
    linkedId?: number | null;
    /** All accounts for selector */
    accounts: Account[];
    /** Connector source for suggestions */
    source?: string | null;
    /** Network/chain for suggestion disambiguation */
    network?: string | null;
    /** Called when user edits the source text. Should clear linkedId upstream. */
    onSourceChange?: (newSource: string) => Promise<void>;
    /** Called when user links to an account (via selector or suggestion) */
    onLink: (accountId: number | null) => Promise<void>;
    /** Font size */
    fontSize?: string;
    /** Badge color palette */
    colorPalette?: string;
    /** Badge max length */
    maxLength?: number;
    /** Whether source text is copyable */
    copyable?: boolean;
    /** Truncate length for source display */
    truncateLength?: number;
    /** Callback to quick-create a new account (opens AccountFormDialog) */
    onCreateNew?: () => void;
}

export const LinkableAccountField: React.FC<LinkableAccountFieldProps> = ({
    label,
    sourceValue,
    linkedId,
    accounts,
    source,
    network,
    onSourceChange,
    onLink,
    fontSize = '10px',
    colorPalette = 'purple',
    maxLength = 18,
    copyable = false,
    truncateLength,
    onCreateNew,
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editingSource, setEditingSource] = useState(false);
    const [localSource, setLocalSource] = useState(sourceValue || '');
    const [isSaving, setIsSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Sync local source when prop changes
    useEffect(() => {
        if (!editingSource) setLocalSource(sourceValue || '');
    }, [sourceValue, editingSource]);

    // Click-outside to close edit mode
    useEffect(() => {
        if (!isEditing) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsEditing(false);
                setEditingSource(false);
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 100);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isEditing]);

    // Global Escape to close
    useEffect(() => {
        if (!isEditing) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsEditing(false);
                setEditingSource(false);
                setLocalSource(sourceValue || '');
            }
        };
        document.addEventListener('keydown', handleEscape, true);
        return () => document.removeEventListener('keydown', handleEscape, true);
    }, [isEditing, sourceValue]);

    const account = accounts.find(a => a.id === linkedId);
    const isLinked = linkedId != null && account != null;

    const handleAcceptSuggestion = async (suggestion: AccountSuggestion) => {
        setIsSaving(true);
        try {
            await onLink(suggestion.id);
            setIsEditing(false);
        } catch { /* ignore */ }
        finally { setIsSaving(false); }
    };

    const handleSelectAccount = async (id: number | null) => {
        setIsSaving(true);
        try {
            await onLink(id);
            setIsEditing(false);
        } catch { /* ignore */ }
        finally { setIsSaving(false); }
    };

    const handleSourceSave = async () => {
        if (localSource === (sourceValue || '')) {
            setEditingSource(false);
            return;
        }
        if (!onSourceChange) return;
        setIsSaving(true);
        try {
            await onSourceChange(localSource);
            setEditingSource(false);
        } catch {
            setLocalSource(sourceValue || '');
        } finally {
            setIsSaving(false);
        }
    };

    // ---- Edit mode: show selector + suggestions ----
    if (isEditing) {
        return (
            <div ref={containerRef} className="py-0.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="shrink-0 font-medium text-blue-600" style={{ fontSize }}>{label}</span>
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                </div>

                {/* Editable source text */}
                {onSourceChange && (
                    <div className="mb-1 flex items-center gap-1">
                        <span className="shrink-0 text-[9px] text-slate-500">Source:</span>
                        {editingSource ? (
                            <input
                                value={localSource}
                                onChange={(e) => setLocalSource(e.target.value)}
                                onBlur={handleSourceSave}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleSourceSave(); }
                                }}
                                autoFocus
                                className="flex-1 border border-slate-300 bg-white px-1 py-0.5 font-mono text-[9px] outline-none focus:border-blue-500"
                            />
                        ) : (
                            <span
                                className={`flex-1 cursor-pointer font-mono text-[9px] hover:text-blue-500 ${sourceValue ? 'text-slate-600' : 'text-slate-400'}`}
                                onClick={() => setEditingSource(true)}
                            >
                                {sourceValue || '(empty)'}
                            </span>
                        )}
                    </div>
                )}

                {/* Account selector */}
                <AccountSelector
                    value={linkedId ?? null}
                    onChange={handleSelectAccount}
                    accounts={accounts}
                    size="xs"
                    defaultName={sourceValue || ''}
                    rawAccountSource={source || undefined}
                    rawAccountLabel={sourceValue || undefined}
                    rawAccountNetwork={network || undefined}
                />

                {/* Suggestions */}
                {sourceValue && !isLinked && (
                    <div className="mt-1">
                        <AccountSuggestionBadges
                            label={sourceValue}
                            source={source}
                            network={network}
                            onAccept={handleAcceptSuggestion}
                            maxResults={3}
                            minConfidence={0.4}
                            fontSize="8px"
                        />
                    </div>
                )}
            </div>
        );
    }

    // ---- View mode ----
    return (
        <div
            className="group -mx-1 flex cursor-pointer items-center justify-between gap-2 border border-transparent px-1 py-0.5 transition-all hover:border-blue-200 hover:bg-blue-50"
            onClick={() => setIsEditing(true)}
        >
            <span className="shrink-0 text-slate-500" style={{ fontSize }}>{label}</span>
            <div className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-blue-400 opacity-0 transition-opacity group-hover:opacity-50">
                    <FiEdit2 size={9} />
                </span>

                {isLinked ? (
                    <div className="flex items-center gap-1">
                        {/* Show truncated source address when copyable and different from account name */}
                        {copyable && sourceValue && (
                            <>
                                <span className="break-all font-mono text-[9px] text-slate-500">
                                    {truncateLength && sourceValue.length > truncateLength
                                        ? `${sourceValue.slice(0, truncateLength)}…`
                                        : sourceValue}
                                </span>
                                <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                    <button
                                        type="button"
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation();
                                            navigator.clipboard.writeText(sourceValue);
                                            setCopied(true);
                                            setTimeout(() => setCopied(false), 2000);
                                        }}
                                        className={`shrink-0 cursor-pointer opacity-50 ${copied ? 'text-green-500 hover:text-green-500' : 'text-slate-400 hover:text-blue-500'}`}
                                    >
                                        {copied ? <FiCheck size={9} /> : <FiCopy size={9} />}
                                    </button>
                                </Tooltip>
                                <span className="text-[9px] text-slate-400">→</span>
                            </>
                        )}
                        <AccountBadge
                            account={account}
                            accountId={linkedId}
                            sourceAccount={sourceValue}
                            sourceLabel={sourceValue}
                            size="xs"
                            colorPalette={colorPalette}
                            maxLength={maxLength}
                        />
                    </div>
                ) : sourceValue ? (
                    <div className="flex items-center gap-1">
                        <span
                            className="break-all text-right font-mono text-orange-500"
                            style={{ fontSize }}
                        >
                            {truncateLength && sourceValue.length > truncateLength
                                ? `${sourceValue.slice(0, truncateLength)}…`
                                : sourceValue}
                        </span>
                        {copyable && (
                            <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                <button
                                    type="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(sourceValue);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    }}
                                    className={`shrink-0 cursor-pointer opacity-50 ${copied ? 'text-green-500 hover:text-green-500' : 'text-slate-400 hover:text-blue-500'}`}
                                >
                                    {copied ? <FiCheck size={9} /> : <FiCopy size={9} />}
                                </button>
                            </Tooltip>
                        )}
                        <Tooltip content="Link account" openDelay={200}>
                            <button
                                type="button"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setIsEditing(true);
                                }}
                                className="shrink-0 cursor-pointer text-orange-400 hover:text-blue-500"
                            >
                                <FiLink size={9} />
                            </button>
                        </Tooltip>
                        {onCreateNew && (
                            <Tooltip content="Create new account" openDelay={100}>
                                <button
                                    type="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        onCreateNew();
                                    }}
                                    className="shrink-0 cursor-pointer text-green-500 hover:text-green-700"
                                >
                                    <FiPlusCircle size={9} />
                                </button>
                            </Tooltip>
                        )}
                        <AccountSuggestionBadges
                            label={sourceValue}
                            source={source}
                            network={network}
                            onAccept={handleAcceptSuggestion}
                            maxResults={2}
                            minConfidence={0.5}
                            fontSize="7px"
                        />
                    </div>
                ) : (
                    <span className="text-slate-400" style={{ fontSize }}>-</span>
                )}
            </div>
        </div>
    );
};

export default LinkableAccountField;
