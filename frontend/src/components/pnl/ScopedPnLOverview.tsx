import React, { useContext, useMemo, useState } from 'react';
import {
    useBookMetrics,
    useLiveMetrics,
    usePortfolioTimeline,
    useReturnMetrics,
    useVersionPerformers,
    type GroupBy,
    type RangeKey,
} from '../../hooks/useChartData';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { AccountDetailPanelContext } from '../../contexts/AccountDetailPanelContext';
import { TimeframeIndicators, type Range } from './TotalReturnScorecard';

interface ScopedPnLOverviewProps {
    versionId: number;
    baseCurrency: string;
    accountIds?: number[];
    assetIds?: number[];
    contextLabel?: string;
    defaultGroupBy?: GroupBy;
}

function readMainBenchmark(): string | undefined {
    try { return localStorage.getItem('pnl.benchmark') || undefined; } catch { return undefined; }
}

/** The P&L overview (periods, cards, TWR/IRR, contributors, chart) for one account or asset, outside PnLContext. */
export const ScopedPnLOverview: React.FC<ScopedPnLOverviewProps> = ({
    versionId, baseCurrency, accountIds, assetIds, contextLabel, defaultGroupBy = 'asset',
}) => {
    const [range, setRange] = useState<Range>('all');
    const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy);
    const scope = useMemo(() => ({ accountIds, assetIds }), [accountIds, assetIds]);
    const timeline = usePortfolioTimeline(versionId, { ...scope, granularity: 'daily' });
    const book = useBookMetrics(versionId, scope);
    const live = useLiveMetrics(versionId, scope);
    const performers = useVersionPerformers(versionId, { ...scope, period: range, groupBy, topN: 500 });
    const returns = useReturnMetrics(versionId, scope);
    const assetPanel = useContext(AssetDetailPanelContext);
    const accountPanel = useContext(AccountDetailPanelContext);
    const mainBenchmark = useMemo(readMainBenchmark, []);

    const onPerformerClick = (id: number, type: string) => {
        if (type === 'asset') assetPanel?.openAssetPanel(id, { pnlVersionId: versionId });
        else if (type === 'account') accountPanel?.openAccountPanel(id, { pnlVersionId: versionId });
    };

    return (
        <TimeframeIndicators
            points={timeline.data?.points ?? []}
            baseCurrency={baseCurrency}
            isLoading={book.isLoading && !book.data}
            range={range}
            onRangeChange={setRange}
            bookData={book.data ?? undefined}
            liveData={live.data ?? undefined}
            isLiveLoading={live.isLoading}
            performersData={performers.data ?? undefined}
            isPerformersLoading={performers.isLoading}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            onPerformerClick={onPerformerClick}
            versionId={versionId}
            contextLabel={contextLabel}
            assetId={assetIds?.length === 1 ? assetIds[0] : undefined}
            assetSymbol={assetIds?.length === 1 ? contextLabel : undefined}
            returnMetrics={returns.data?.ranges?.[range as RangeKey] ?? null}
            mainBenchmark={mainBenchmark}
        />
    );
};
