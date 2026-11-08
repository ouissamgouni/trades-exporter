/**
 * Shared vocabulary for the two cost tracks (see docs/PNL_AND_COST_LOTS.md):
 * Realized (economic), Taxable, Deferred, Deferred in, Taxable if sold now.
 */

import React from 'react';
import { LuInfo } from 'react-icons/lu';
import { Badge } from '../ui/primitives';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';

export interface RealizedViewFields {
    pnl_in_base: number;
    cost_basis_in_base: number;
    economic_pnl_in_base?: number | null;
    economic_cost_basis_in_base?: number | null;
}

const EPS = 0.005;

export const realizedOf = (e: RealizedViewFields): number => e.economic_pnl_in_base ?? e.pnl_in_base;
export const realizedCostOf = (e: RealizedViewFields): number => e.economic_cost_basis_in_base ?? e.cost_basis_in_base;

/** Tax P&L − Realized: gain from earlier tax-deferred swaps carried by the consumed lots. */
export const deferredInOf = (e: RealizedViewFields): number => {
    const d = e.pnl_in_base - realizedOf(e);
    return Math.abs(d) < EPS ? 0 : d;
};

export const TERM_HELP = {
    realized: 'Gain earned while you held the asset: proceeds − cost, where cost is the market value when you received it. Each gain is counted once.',
    taxable: 'Gain on taxable disposals, measured from your original purchase cost carried through tax-deferred swaps. This is what tax reports use.',
    deferred: 'Gain already counted in Realized (locked in by tax-deferred swaps) but not taxed yet. It is released when the holdings are disposed of in a taxable event; later price moves can add to or offset it.',
    deferredIn: 'Gain from earlier tax-deferred swaps carried by the lots consumed here. Released (taxed now) on taxable disposals; rolled over into the new asset otherwise.',
    taxableIfSold: 'Gain that would be taxable if these holdings were sold now: market value − original (tax) cost = Unrealized + Deferred held here.',
    taxCost: 'Original purchase cost carried through tax-deferred swaps. Used for taxable gains.',
    cost: 'Cost of what you hold now: market value when each asset was received (purchase price, or value at the swap).',
    netDeposits: 'Money brought in from outside minus money taken out, valued when it moved. Value − Net deposits = Total return. Swaps and sales between your assets do not count.',
    totalBought: 'Everything ever acquired for this asset (purchases and swaps), at the value received. Grows with every trade, so it can exceed the money you put in.',
} as const;

export const InfoTip: React.FC<{ text: string; size?: number }> = ({ text, size = 10 }) => (
    <Tooltip content={<div className="max-w-[260px] text-xs">{text}</div>}>
        <span className="inline-flex text-gray-400 hover:text-gray-600" aria-label={text} onClick={(e) => e.stopPropagation()}>
            <LuInfo size={size} />
        </span>
    </Tooltip>
);

export const TaxabilityPill: React.FC<{ taxable: boolean; isFee?: boolean }> = ({ taxable, isFee }) => {
    if (taxable) {
        return (
            <Tooltip content="Taxable disposal: the gain is taxed now">
                <Badge colorScheme="red" className="text-[10px]">Taxable</Badge>
            </Tooltip>
        );
    }
    if (isFee) {
        return (
            <Tooltip content="Fee disposal not treated as taxable">
                <Badge colorScheme="gray" className="text-[10px]">Not taxable</Badge>
            </Tooltip>
        );
    }
    return (
        <Tooltip content="Tax-deferred: the gain rolls over into the asset received and is taxed at a later taxable disposal">
            <Badge colorScheme="blue" className="text-[10px]">Deferred</Badge>
        </Tooltip>
    );
};

export const TaxableGainValue: React.FC<{ entry: RealizedViewFields; taxable: boolean; currency: string }> = ({ entry, taxable, currency }) =>
    taxable
        ? <ValueDisplay value={entry.pnl_in_base} currency={currency} />
        : <span className="text-[10px] text-gray-400">—</span>;

export const DeferredInValue: React.FC<{ entry: RealizedViewFields; taxable: boolean; currency: string }> = ({ entry, taxable, currency }) => {
    const d = deferredInOf(entry);
    if (d === 0) return <span className="text-[10px] text-gray-400">—</span>;
    return (
        <span className="inline-flex flex-col items-end">
            <ValueDisplay value={d} currency={currency} />
            <span className={`text-[9px] ${taxable ? 'text-red-500' : 'text-blue-500'}`}>
                {taxable ? 'released' : 'rolled over'}
            </span>
        </span>
    );
};
