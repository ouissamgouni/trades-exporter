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
import { Box, Flex, Input, Text } from '@chakra-ui/react';
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
            <Box ref={containerRef} py={0.5}>
                <Flex justify="space-between" gap={2} align="center" mb={1}>
                    <Text fontSize={fontSize} color="blue.600" fontWeight="medium" flexShrink={0}>{label}</Text>
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                </Flex>

                {/* Editable source text */}
                {onSourceChange && (
                    <Flex align="center" gap={1} mb={1}>
                        <Text fontSize="9px" color="gray.500" flexShrink={0}>Source:</Text>
                        {editingSource ? (
                            <Input
                                size="xs"
                                fontSize="9px"
                                fontFamily="mono"
                                value={localSource}
                                onChange={(e) => setLocalSource(e.target.value)}
                                onBlur={handleSourceSave}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleSourceSave(); }
                                }}
                                autoFocus
                                flex={1}
                            />
                        ) : (
                            <Text
                                fontSize="9px"
                                fontFamily="mono"
                                color={sourceValue ? 'gray.600' : 'gray.400'}
                                cursor="pointer"
                                _hover={{ color: 'blue.500' }}
                                onClick={() => setEditingSource(true)}
                                flex={1}
                            >
                                {sourceValue || '(empty)'}
                            </Text>
                        )}
                    </Flex>
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
                    <Box mt={1}>
                        <AccountSuggestionBadges
                            label={sourceValue}
                            source={source}
                            network={network}
                            onAccept={handleAcceptSuggestion}
                            maxResults={3}
                            minConfidence={0.4}
                            fontSize="8px"
                        />
                    </Box>
                )}
            </Box>
        );
    }

    // ---- View mode ----
    return (
        <Flex
            justify="space-between"
            py={0.5}
            gap={2}
            align="center"
            cursor="pointer"
            onClick={() => setIsEditing(true)}
            px={1}
            mx={-1}
            borderWidth="1px"
            borderColor="transparent"
            borderRadius="sm"
            transition="all 0.1s"
            _hover={{ borderColor: 'blue.200', bg: 'blue.50' }}
            css={{ '&:hover .ef-pencil': { opacity: 0.5 } }}
        >
            <Text fontSize={fontSize} color="gray.500" flexShrink={0}>{label}</Text>
            <Flex
                align="center"
                gap={1}
                minW={0}
            >
                <Box
                    className="ef-pencil"
                    opacity={0}
                    transition="opacity 0.15s"
                    flexShrink={0}
                    color="blue.400"
                >
                    <FiEdit2 size={9} />
                </Box>

                {isLinked ? (
                    <Flex align="center" gap={1}>
                        {/* Show truncated source address when copyable and different from account name */}
                        {copyable && sourceValue && (
                            <>
                                <Text
                                    fontSize="9px"
                                    fontFamily="mono"
                                    color="gray.500"
                                    css={{ wordBreak: 'break-all' }}
                                >
                                    {truncateLength && sourceValue.length > truncateLength
                                        ? `${sourceValue.slice(0, truncateLength)}…`
                                        : sourceValue}
                                </Text>
                                <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                    <Box
                                        as="button"
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation();
                                            navigator.clipboard.writeText(sourceValue);
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
                                <Text fontSize="9px" color="gray.400">→</Text>
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
                    </Flex>
                ) : sourceValue ? (
                    <Flex align="center" gap={1}>
                        <Text
                            fontSize={fontSize}
                            fontFamily="mono"
                            color="orange.500"
                            textAlign="right"
                            css={{ wordBreak: 'break-all' }}
                        >
                            {truncateLength && sourceValue.length > truncateLength
                                ? `${sourceValue.slice(0, truncateLength)}…`
                                : sourceValue}
                        </Text>
                        {copyable && (
                            <Tooltip content={copied ? 'Copied!' : 'Copy'} openDelay={100} closeDelay={copied ? 1000 : 200}>
                                <Box
                                    as="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(sourceValue);
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
                        )}
                        <Tooltip content="Link account" openDelay={200}>
                            <Box
                                as="button"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setIsEditing(true);
                                }}
                                color="orange.400"
                                _hover={{ color: 'blue.500' }}
                                cursor="pointer"
                                flexShrink={0}
                            >
                                <FiLink size={9} />
                            </Box>
                        </Tooltip>
                        {onCreateNew && (
                            <Tooltip content="Create new account" openDelay={100}>
                                <Box
                                    as="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        onCreateNew();
                                    }}
                                    color="green.500"
                                    cursor="pointer"
                                    flexShrink={0}
                                    _hover={{ color: 'green.700' }}
                                >
                                    <FiPlusCircle size={9} />
                                </Box>
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
                    </Flex>
                ) : (
                    <Text fontSize={fontSize} color="gray.400">-</Text>
                )}
            </Flex>
        </Flex>
    );
};

export default LinkableAccountField;
