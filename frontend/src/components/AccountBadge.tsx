/**
 * AccountBadge - Reusable component for displaying account information
 * 
 * Features:
 * - Displays resolved account name when linked
 * - Shows warning state for unlinked accounts (sourceAccount fallback)
 * - Supports onClick for inline editing scenarios
 * - Shows full details on hover via Tooltip
 */

import React from 'react';
import { FiHome, FiGlobe } from 'react-icons/fi';
import { Badge } from './ui/primitives';
import { Tooltip } from './ui/tooltip';
import { Account } from '../types';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';

export interface AccountBadgeProps {
    /** Linked account object */
    account?: Account | null;
    /** Account ID if no full account object provided */
    accountId?: number | null;
    /** Resolved account name (if account object not provided) */
    accountName?: string | null;
    /** Fallback source account label when not linked (shows warning state) */
    sourceAccount?: string | null;
    /** Original source label to display on hover when account is linked */
    sourceLabel?: string | null;
    /** Badge size */
    size?: 'xs' | 'sm' | 'md';
    /** Color palette for the badge (overrides entity color if provided) */
    colorPalette?: string;
    /** Use auto-assigned entity color instead of static colorPalette (default: true) */
    useEntityColor?: boolean;
    /** Maximum characters before truncating */
    maxLength?: number;
    /** Click handler for inline editing */
    onClick?: (e: React.MouseEvent) => void;
    /** Show warning icon/style for unlinked state */
    showWarning?: boolean;
    /** Custom fallback text when no account and no sourceAccount */
    fallback?: string;
}

/**
 * AccountBadge component for consistent account display across the app
 */
export const AccountBadge: React.FC<AccountBadgeProps> = ({
    account,
    accountId,
    accountName,
    sourceAccount,
    sourceLabel,
    size = 'xs',
    colorPalette: colorPaletteProp,
    useEntityColor = true,
    maxLength = 20,
    onClick,
    showWarning = true,
    fallback = '-',
}) => {
    const { getAccountColor } = useEntityColors();

    // Determine what to display
    const resolvedId = account?.id ?? accountId;
    const resolvedName = account?.name ?? accountName;
    const hasLinkedAccount = resolvedId != null && resolvedName;
    const hasSourceAccount = !!sourceAccount;

    // Resolve color: prefer DB-stored color, then entity color hook, then prop fallback
    const entityColor = (() => {
        // useEntityColors already handles priority: dbColor > localStorage > hash
        if (useEntityColor && hasLinkedAccount) return getAccountColor(resolvedId, resolvedName, account?.color);
        // Explicit prop or default
        return colorPaletteProp ?? '#9467BD';
    })();

    // Unlinked state: no account but has source account label
    if (!hasLinkedAccount && hasSourceAccount && showWarning) {
        return (
            <Tooltip
                content={
                    <div className="p-2 text-xs">
                        <div className="mb-1 font-bold text-orange-300">⚠ Unlinked Account</div>
                        <div className="flex justify-between gap-4">
                            <span className="text-slate-400">Source Label</span>
                            <span className="text-white">{sourceAccount}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-400">
                            Click to link to an account
                        </div>
                    </div>
                }
                openDelay={200}
            >
                <Badge
                    colorScheme="orange"
                    className={onClick ? 'cursor-pointer' : 'cursor-default'}
                    onClick={onClick}
                >
                    ⚠ {sourceAccount.length > maxLength ? sourceAccount.slice(0, maxLength) + '…' : sourceAccount}
                </Badge>
            </Tooltip>
        );
    }

    // No account and no source account
    if (!hasLinkedAccount) {
        return (
            <span
                className={onClick ? 'cursor-pointer text-slate-400' : 'cursor-default text-slate-400'}
                style={{ fontSize: size === 'xs' ? '9px' : size === 'sm' ? '11px' : '13px' }}
                onClick={onClick}
            >
                {fallback}
            </span>
        );
    }

    // Determine ownership state
    const isOwned = account?.owned;
    const ownershipKnown = account != null && typeof account.owned === 'boolean';
    const OwnershipIcon = isOwned ? FiHome : FiGlobe;
    const ownershipLabel = isOwned ? 'Owned' : 'External';

    // Format display string with truncation
    const displayName = resolvedName.length > maxLength
        ? resolvedName.slice(0, maxLength) + '…'
        : resolvedName;

    // Build tooltip content
    const tooltipContent = (
        <div className="min-w-[150px] p-2 text-xs">
            <div className="mb-1 flex justify-between gap-4">
                <span className="text-slate-400">Name</span>
                <span className="font-medium text-white">{resolvedName}</span>
            </div>
            {ownershipKnown && (
                <div className="mb-1 flex items-center justify-between gap-4">
                    <span className="text-slate-400">Ownership</span>
                    <span className="flex items-center gap-1">
                        <OwnershipIcon size={10} />
                        <span className={isOwned ? 'text-green-300' : 'text-orange-300'}>{ownershipLabel}</span>
                    </span>
                </div>
            )}
            {sourceLabel && sourceLabel !== resolvedName && (
                <div className="mb-1 flex justify-between gap-4">
                    <span className="text-slate-400">Source</span>
                    <span className="max-w-[180px] truncate font-mono text-[10px] text-slate-300">
                        {sourceLabel}
                    </span>
                </div>
            )}
            {account?.account_type && (
                <div className="mb-1 flex justify-between gap-4">
                    <span className="text-slate-400">Type</span>
                    <span className="text-white">{account.account_type}</span>
                </div>
            )}
            {account?.address_or_identifier && (
                <div className="mb-1 flex justify-between gap-4">
                    <span className="text-slate-400">Address</span>
                    <span className="font-mono text-[10px] text-slate-300">
                        {account.address_or_identifier.slice(0, 16)}...
                    </span>
                </div>
            )}
            {resolvedId && (
                <div className="flex justify-between gap-4">
                    <span className="text-slate-400">ID</span>
                    <span className="text-slate-300">#{resolvedId}</span>
                </div>
            )}
        </div>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <span
                className={`inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-medium leading-tight ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
                style={{ backgroundColor: hexToRgba(entityColor, 0.18), color: entityColor }}
                onClick={onClick}
                title={resolvedName.length > maxLength ? resolvedName : undefined}
            >
                {ownershipKnown && <OwnershipIcon size={size === 'xs' ? 9 : size === 'sm' ? 11 : 13} />}
                {displayName}
            </span>
        </Tooltip>
    );
};

export default AccountBadge;
