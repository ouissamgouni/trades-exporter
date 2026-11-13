/**
 * AssetDetailsForm — asset settings as section cards (Identity, Pricing & classification, Tags).
 * Fields are inline-editable (EditableField): click to edit, Enter/blur saves, Escape cancels.
 */

import React from 'react';
import { API_URL, Asset } from '../types';
import { EditableField } from './EditableField';
import { toaster } from './ui/toaster';
import { useAssets } from '../hooks/useAssets';
import { Badge } from './ui/primitives';

const NOOP = async () => { };
const FIELD_FONT = '12px';

const PRICE_TYPE_OPTIONS = [
    { label: '— Not set —', value: '' },
    { label: 'crypto', value: 'crypto' },
    { label: 'stock', value: 'stock' },
    { label: 'fiat', value: 'fiat' },
];

interface AssetDetailsFormProps {
    asset: Asset;
    onSaved?: () => void;
}

export const SettingsSection: React.FC<{ title: string; hint?: string; aside?: React.ReactNode; tone?: 'default' | 'danger'; children: React.ReactNode }> = ({ title, hint, aside, tone = 'default', children }) => (
    <section className={`border bg-white ${tone === 'danger' ? 'border-red-200' : 'border-slate-200'}`}>
        <header className={`flex items-start justify-between gap-3 border-b px-3 py-2 ${tone === 'danger' ? 'border-red-100 bg-red-50/60' : 'border-slate-100 bg-slate-50'}`}>
            <div className="min-w-0">
                <h4 className={`text-xs font-semibold ${tone === 'danger' ? 'text-red-700' : 'text-slate-700'}`}>{title}</h4>
                {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
            </div>
            {aside}
        </header>
        <div className="px-3 py-2">{children}</div>
    </section>
);

export const AssetDetailsForm: React.FC<AssetDetailsFormProps> = ({ asset, onSaved }) => {
    const { assets: allAssets } = useAssets();

    const denominationCurrencyOptions = React.useMemo(() => {
        const fiatAssets = allAssets.filter(a => a.price_type === 'fiat' && a.asset_id);
        return [
            { label: '— Not set —', value: '' },
            ...fiatAssets.map(a => ({ label: `${a.symbol}${a.label ? ` (${a.label})` : ''}`, value: String(a.asset_id) })),
        ];
    }, [allAssets]);

    const patchField = async (field: string, rawValue: string | null) => {
        if (!asset.asset_id) return;
        let value: string | number | null = rawValue;
        if (field === 'status') value = parseInt(rawValue as string);
        if (field === 'denomination_currency_id') value = rawValue ? parseInt(rawValue) : null;
        if (field === 'isin') value = rawValue || null;
        const response = await fetch(`${API_URL}/assets/${asset.asset_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
        });
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || 'Failed to update');
        }
        toaster.success({ title: 'Asset updated' });
        onSaved?.();
    };

    const active = asset.status === 0;

    return (
        <div className="flex flex-col gap-3">
            <SettingsSection title="Identity" hint="How this asset is named and recognised across imports and price sources.">
                <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                    <div>
                        <EditableField label="Symbol" value={asset.symbol || ''} onSave={v => patchField('symbol', v)} fontSize={FIELD_FONT} />
                        <EditableField label="Label" value={asset.label || ''} onSave={v => patchField('label', v)} fontSize={FIELD_FONT} />
                        <EditableField label="ISIN" value={asset.isin || ''} onSave={v => patchField('isin', v)} fontSize={FIELD_FONT} />
                    </div>
                    <div>
                        <EditableField label="Asset ID" value={asset.asset_id != null ? `#${asset.asset_id}` : '-'} onSave={NOOP} editable={false} muted copyable fontSize={FIELD_FONT} />
                        <EditableField label="Created" value={asset.created_at ? new Date(asset.created_at).toLocaleDateString() : '-'} onSave={NOOP} editable={false} muted fontSize={FIELD_FONT} />
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection
                title="Pricing & classification"
                hint="Price type picks the price sources; the denomination currency is the currency prices are quoted in."
                aside={<Badge colorScheme={active ? 'green' : 'gray'}>{active ? 'Active' : 'Inactive'}</Badge>}
            >
                <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                    <div>
                        <EditableField
                            label="Price type"
                            value={asset.price_type || ''}
                            type="select"
                            options={PRICE_TYPE_OPTIONS}
                            onSave={v => patchField('price_type', v)}
                            fontSize={FIELD_FONT}
                        />
                        <EditableField
                            label="Denomination currency"
                            value={String(asset.denomination_currency_id ?? '')}
                            type="select"
                            options={denominationCurrencyOptions}
                            displayValue={
                                asset.denomination_currency
                                    ? <Badge colorScheme="green">{asset.denomination_currency.symbol}</Badge>
                                    : <span className="text-[11px] text-slate-400">Not set</span>
                            }
                            onSave={v => patchField('denomination_currency_id', v)}
                            fontSize={FIELD_FONT}
                        />
                    </div>
                    <div>
                        <EditableField
                            label="Active"
                            value={active ? 'true' : 'false'}
                            type="checkbox"
                            onSave={v => patchField('status', v === 'true' ? '0' : '1')}
                            fontSize={FIELD_FONT}
                        />
                    </div>
                </div>
            </SettingsSection>

            {asset.tags && asset.tags.length > 0 && (
                <SettingsSection title="Tags" hint="Set by importers and connectors (read-only).">
                    <div className="flex flex-wrap gap-1">
                        {asset.tags.map((tag, i) => (
                            <Badge key={i} colorScheme="blue" className="text-[10px]">
                                {Object.entries(tag).map(([k, v]) => `${k}: ${v}`).join(', ')}
                            </Badge>
                        ))}
                    </div>
                </SettingsSection>
            )}
        </div>
    );
};

export default AssetDetailsForm;
