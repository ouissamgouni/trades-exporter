/**
 * SourceInfoCell - Compact display of transaction source information
 * 
 * Shows: Account (with badge or warning) + Source + Source Type + Source Symbol + Connector info
 * Used in transaction tables and data health check panels.
 */

import React from 'react';
import { FiAlertTriangle, FiPlusCircle, FiCopy, FiCheck } from 'react-icons/fi';
import { Account } from '../types';
import { AccountBadge } from './AccountBadge';
import { Tooltip } from './ui/tooltip';
import { Badge, type BadgeColorScheme } from './ui/primitives';
import { getConfidenceColor, formatConfidence } from '../utils/similarity';
import { useAccountSuggestions, AccountSuggestion } from '../hooks/useAccountSuggestions';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';

const SCHEMES = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toScheme = (c: string): BadgeColorScheme => {
    if (c === 'grey') return 'gray';
    if (c === 'pink') return 'purple';
    if (c === 'teal') return 'green';
    return (SCHEMES.includes(c) ? c : 'gray') as BadgeColorScheme;
};

export interface SourceInfoCellProps {
    sourceAccount?: string;      // Raw source_account field
    accountId?: number | null;   // Resolved account_id (to show warning if missing)
    resolvedAccount?: Account;   // Full resolved account object
    resolvedAccountName?: string; // Resolved account name for display
    source: string;
    sourceType?: string;
    sourceSymbol?: string;
    sourceTransactionId?: string; // Source transaction ID (displayed truncated at bottom)
    onClick?: () => void;
    /** 
     * Account suggestions for quick linking.
     * If not provided, the component self-fetches from the backend using
     * source, sourceAccount, and network for network-aware disambiguation.
     */
    accountSuggestions?: AccountSuggestion[];
    /** Callback to accept a suggested account */
    onAcceptSuggestion?: (accountId: number) => void;
    /** Callback to quick-create a new account (opens AccountFormDialog) */
    onCreateAccount?: () => void;
    /** Connector metadata */
    connectorName?: string | null;
    runDatetime?: string | null;
    syncConnectorRunId?: number | null;
    onConnectorRunClick?: (runId: number) => void;
    network?: string | null;
}

export const SourceInfoCell: React.FC<SourceInfoCellProps> = ({
    sourceAccount,
    accountId,
    resolvedAccount,
    resolvedAccountName,
    source,
    sourceType,
    sourceSymbol,
    sourceTransactionId,
    onClick,
    accountSuggestions: externalSuggestions,
    onAcceptSuggestion,
    onCreateAccount,
    connectorName,
    runDatetime,
    syncConnectorRunId,
    onConnectorRunClick,
    network,
}) => {
    // Determine if account is linked (resolved)
    const isAccountLinked = accountId != null;
    const needsSuggestions = !isAccountLinked && !!sourceAccount && !externalSuggestions;

    // Self-fetch suggestions when none provided externally (network-aware)
    const { suggestions: fetchedSuggestions } = useAccountSuggestions({
        label: sourceAccount,
        source,
        network,
        maxResults: 2,
        enabled: needsSuggestions,
    });

    const [copied, setCopied] = React.useState(false);
    const { getConnectorColor } = useEntityColors();
    const sourceColor = getConnectorColor(connectorName || source);

    const accountSuggestions = externalSuggestions ?? (needsSuggestions ? fetchedSuggestions : []);

    return (
        <div className="flex min-w-[100px] max-w-[200px] flex-col gap-1">
            {/* First row: Account badge + Source badge */}
            <div className="flex flex-wrap items-center gap-1">
                {/* Account badge */}
                {isAccountLinked ? (
                    <div className="inline-block max-w-fit">
                        <AccountBadge
                            account={resolvedAccount}
                            accountId={accountId}
                            accountName={resolvedAccountName}
                            size="xs"
                            maxLength={14}
                            onClick={onClick}
                        />
                    </div>
                ) : sourceAccount ? (
                    <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-1">
                            <FiAlertTriangle size={10} color="#dd6b20" style={{ flexShrink: 0 }} />
                            <span
                                className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-medium text-orange-600"
                                onClick={onClick}
                                title={sourceAccount ? `Unlinked: ${sourceAccount}` : 'No account linked'}
                            >
                                {sourceAccount.length > 12 ? sourceAccount.slice(0, 12) + '...' : sourceAccount}
                            </span>
                            {onCreateAccount && (
                                <Tooltip content="Create new account">
                                    <button
                                        type="button"
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onCreateAccount(); }}
                                        className="shrink-0 cursor-pointer text-green-500 hover:text-green-700"
                                        aria-label="Create new account"
                                    >
                                        <FiPlusCircle size={10} />
                                    </button>
                                </Tooltip>
                            )}
                        </div>
                        {/* Show compact suggestion chips for unlinked accounts */}
                        {accountSuggestions.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                                {accountSuggestions.slice(0, 2).map((s, idx) => (
                                    <Tooltip key={idx} content={`${formatConfidence(s.confidence)} match - Click to link`}>
                                        <Badge
                                            colorScheme={toScheme(getConfidenceColor(s.confidence))}
                                            className={`cursor-pointer ${s.confidence >= 0.9 ? 'font-semibold' : ''}`}
                                            style={{ fontSize: '7px' }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onAcceptSuggestion?.(s.id);
                                            }}
                                        >
                                            {s.name.slice(0, 10)}{s.name.length > 10 ? '…' : ''}
                                            {s.confidence >= 0.9 && ' ✓'}
                                        </Badge>
                                    </Tooltip>
                                ))}
                            </div>
                        )}
                    </div>
                ) : null}

                {/* Source badge */}
                <Tooltip content={`Source: ${source}`}>
                    <span
                        className="inline-block max-w-[120px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap px-1 py-px font-medium leading-tight"
                        style={{ fontSize: '9px', backgroundColor: hexToRgba(sourceColor, 0.18), color: sourceColor }}
                    >
                        {source}
                    </span>
                </Tooltip>
            </div>

            {/* Second row: Connector run and other optional badges */}
            <div className="flex flex-wrap items-center gap-1">
                {/* Clickable connector run badge (run ID + date) */}
                {syncConnectorRunId && runDatetime && (
                    <Tooltip content="Click to view connector run details">
                        <Badge
                            colorScheme="gray"
                            className={`inline-block ${onConnectorRunClick ? 'cursor-pointer hover:bg-purple-100' : 'cursor-default'}`}
                            style={{ fontSize: '9px', padding: '1px 4px' }}
                            onClick={(e) => {
                                if (onConnectorRunClick) {
                                    e.stopPropagation();
                                    onConnectorRunClick(syncConnectorRunId);
                                }
                            }}
                        >
                            #{syncConnectorRunId} • {new Date(runDatetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </Badge>
                    </Tooltip>
                )}

                {/* Source type badge (if different from source) */}
                {sourceType && sourceType !== source && (
                    <Badge
                        colorScheme="green"
                        className="inline-block cursor-default"
                        title={`Type: ${sourceType}`}
                        style={{ fontSize: '9px', padding: '1px 4px' }}
                    >
                        {sourceType}
                    </Badge>
                )}

                {/* Source symbol badge (if provided) */}
                {sourceSymbol && (
                    <Tooltip content={`Symbol: ${sourceSymbol}`}>
                        <Badge
                            colorScheme="purple"
                            className="inline-block max-w-[100px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap"
                            style={{ fontSize: '9px', padding: '1px 4px' }}
                        >
                            {sourceSymbol}
                        </Badge>
                    </Tooltip>
                )}

                {/* Network badge (if provided) */}
                {network && (
                    <Tooltip content={`Network: ${network}`}>
                        <Badge
                            colorScheme="purple"
                            className="inline-block max-w-[100px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap"
                            style={{ fontSize: '8px', padding: '1px 4px' }}
                        >
                            {network}
                        </Badge>
                    </Tooltip>
                )}
            </div>

            {/* Third row: Source Transaction ID (truncated, copiable with confirmation) */}
            {sourceTransactionId && (
                <Tooltip content={sourceTransactionId} openDelay={200}>
                    <div
                        className="flex cursor-pointer items-center gap-0.5 hover:text-blue-500"
                        onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(sourceTransactionId);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }}
                        title="Click to copy source transaction ID"
                    >
                        <span
                            className={`max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[7px] ${copied ? 'text-green-500' : 'text-slate-400'}`}
                        >
                            {copied
                                ? 'Copied!'
                                : sourceTransactionId.length > 24
                                    ? sourceTransactionId.slice(0, 12) + '\u2026' + sourceTransactionId.slice(-8)
                                    : sourceTransactionId}
                        </span>
                        <span className={`shrink-0 ${copied ? 'text-green-500' : 'text-slate-300'}`}>
                            {copied ? <FiCheck size={8} /> : <FiCopy size={8} />}
                        </span>
                    </div>
                </Tooltip>
            )}
        </div>
    );
};
