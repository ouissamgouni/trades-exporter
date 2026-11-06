import React, { useContext } from 'react';
import { LuInfo } from 'react-icons/lu';
import { Tooltip } from '../ui/tooltip';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';

interface AssetNameCellProps {
    id: number;
    symbol?: string | null;
    label?: string | null;
    pnlVersionId?: number;
}

/** Asset name (label, else symbol) + small #id + info icon opening the asset side panel. */
export const AssetNameCell: React.FC<AssetNameCellProps> = ({ id, symbol, label, pnlVersionId }) => {
    const panelCtx = useContext(AssetDetailPanelContext);
    const name = label || symbol || `#${id}`;
    return (
        <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip content={symbol ? `Symbol: ${symbol}` : name} openDelay={300}>
                <span className="truncate font-medium text-slate-800">{name}</span>
            </Tooltip>
            <span className="shrink-0 text-[10px] text-slate-400">#{id}</span>
            {panelCtx && (
                <button
                    type="button"
                    aria-label={`View ${name} details`}
                    title="View asset details"
                    className="shrink-0 p-0.5 text-slate-400 hover:bg-blue-50 hover:text-blue-500"
                    onClick={(e) => {
                        e.stopPropagation();
                        panelCtx.openAssetPanel(id, pnlVersionId != null ? { pnlVersionId } : undefined);
                    }}
                >
                    <LuInfo size={12} />
                </button>
            )}
        </div>
    );
};
