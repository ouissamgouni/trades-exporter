/**
 * DrillDownBreadcrumb
 *
 * Renders a prominent breadcrumb bar with navigation trail and period badge.
 * Section toggles live inside ContextView.
 */

import React from 'react';
import { Badge } from '../ui/primitives';
import { FiChevronRight } from 'react-icons/fi';
import { usePnL } from './PnLContext';

export const DrillDownBreadcrumb: React.FC = () => {
    const { state, dispatch } = usePnL();
    const { breadcrumbs, level } = state.drill;
    const timeframeRange = state.timeframeRange;

    const displayCrumbs = breadcrumbs;

    // First crumb shows period inline: "Portfolio · 1W"
    const firstCrumbLabel = displayCrumbs.length > 0
        ? (timeframeRange && timeframeRange !== 'all'
            ? `${displayCrumbs[0].label} · ${timeframeRange.toUpperCase()}`
            : displayCrumbs[0].label)
        : 'Portfolio';

    return (
        <div className="flex flex-wrap items-center gap-1.5 border border-slate-200 bg-slate-50 px-3 py-2">
            {/* Breadcrumb trail */}
            {displayCrumbs.map((crumb, idx) => {
                const isLast = idx === displayCrumbs.length - 1;
                const label = idx === 0 ? firstCrumbLabel : crumb.label;

                return (
                    <React.Fragment key={idx}>
                        {idx > 0 && (
                            <FiChevronRight
                                size={14}
                                className="shrink-0 text-slate-400"
                            />
                        )}
                        {isLast ? (
                            <Badge colorScheme="blue" className="px-2 py-0.5 font-semibold">
                                {label}
                            </Badge>
                        ) : (
                            <span
                                className="cursor-pointer whitespace-nowrap text-sm font-medium text-blue-600 hover:underline"
                                onClick={() => dispatch({ type: 'DRILL_TO_BREADCRUMB', index: idx })}
                            >
                                {label}
                            </span>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
};
