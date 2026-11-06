import React, { useContext } from 'react';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';

interface AssetNameCellProps {
    id: number;
    symbol?: string | null;
    label?: string | null;
    pnlVersionId?: number;
}

/** Asset label + clickable symbol that opens the asset side panel. */
export const AssetNameCell: React.FC<AssetNameCellProps> = ({ id, symbol, label, pnlVersionId }) => {
    const panelCtx = useContext(AssetDetailPanelContext);
    const sym = symbol || `#${id}`;
    const showLabel = !!label && label !== symbol;
    const symbolClass = showLabel ? 'shrink-0 max-w-[45%] text-[10px] text-slate-500' : 'font-medium text-slate-800';
    return (
        <div className="flex min-w-0 items-center gap-1.5">
            {showLabel && <span className="truncate font-medium text-slate-800" title={label!}>{label}</span>}
            {panelCtx ? (
                <button
                    type="button"
                    title={`${sym} — view asset details`}
                    className={`truncate text-left underline decoration-dotted underline-offset-2 hover:text-blue-600 ${symbolClass}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        panelCtx.openAssetPanel(id, pnlVersionId != null ? { pnlVersionId } : undefined);
                    }}
                >
                    {sym}
                </button>
            ) : (
                <span className={`truncate ${symbolClass}`} title={sym}>{sym}</span>
            )}
        </div>
    );
};
