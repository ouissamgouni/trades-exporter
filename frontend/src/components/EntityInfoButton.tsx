import React, { useContext } from 'react';
import { LuInfo } from 'react-icons/lu';
import { AccountDetailPanelContext } from '../contexts/AccountDetailPanelContext';
import { AssetDetailPanelContext } from '../contexts/AssetDetailPanelContext';
import { cn } from '../lib/cn';

interface EntityInfoButtonProps {
    kind: 'account' | 'asset';
    id: number | null | undefined;
    label?: string | null;
    pnlVersionId?: number;
    size?: number;
    className?: string;
}

/** Small info icon that opens the account/asset side panel (renders nothing outside its provider). */
export const EntityInfoButton: React.FC<EntityInfoButtonProps> = ({ kind, id, label, pnlVersionId, size = 11, className }) => {
    const accountCtx = useContext(AccountDetailPanelContext);
    const assetCtx = useContext(AssetDetailPanelContext);
    if (id == null) return null;
    const open = kind === 'account'
        ? accountCtx && (() => accountCtx.openAccountPanel(id, pnlVersionId != null ? { pnlVersionId } : undefined))
        : assetCtx && (() => assetCtx.openAssetPanel(id, pnlVersionId != null ? { pnlVersionId } : undefined));
    if (!open) return null;
    const name = label || `#${id}`;
    return (
        <button
            type="button"
            aria-label={`View ${kind} details: ${name}`}
            title={`View ${kind} details: ${name}`}
            className={cn('inline-flex shrink-0 items-center text-slate-400 hover:text-blue-600', className)}
            onClick={(e) => {
                e.stopPropagation();
                open();
            }}
        >
            <LuInfo size={size} />
        </button>
    );
};
