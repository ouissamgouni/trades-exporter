/**
 * AssetCategoriesEditor — Per-asset category picker organised by dimension.
 *
 * Compact layout with inline checkboxes, xs fonts. Saves per-dimension on toggle.
 */

import React, { useEffect, useState } from 'react';
import { API_URL, Asset, DimensionWithCategories } from '../types';
import { toaster } from './ui/toaster';
import { Badge, Spinner } from './ui/primitives';

interface AssetCategoriesEditorProps {
    asset: Asset;
    onSaved?: () => void;
}

export const AssetCategoriesEditor: React.FC<AssetCategoriesEditorProps> = ({ asset, onSaved }) => {
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setLoading(true);
        fetch(`${API_URL}/categories/by-dimension`)
            .then(r => r.ok ? r.json() : [])
            .then((data: DimensionWithCategories[]) => { setDimensionData(data); setLoading(false); })
            .catch(() => { setDimensionData([]); setLoading(false); });
    }, []);

    useEffect(() => {
        setSelectedIds(new Set((asset.categories || []).map(c => c.id)));
    }, [asset.asset_id, asset.categories]);

    const toggle = async (catId: number) => {
        const next = new Set(selectedIds);
        if (next.has(catId)) next.delete(catId); else next.add(catId);
        setSelectedIds(next);

        if (!asset.asset_id) return;
        setSaving(true);
        try {
            const response = await fetch(`${API_URL}/categories/asset/${asset.asset_id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_ids: Array.from(next) }),
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to save');
            }
            onSaved?.();
        } catch (err) {
            // revert on error
            setSelectedIds(new Set((asset.categories || []).map(c => c.id)));
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="flex justify-center py-3"><Spinner size="sm" /></div>;
    }

    if (dimensionData.length === 0) {
        return <span className="block py-2 text-xs text-slate-500">No categories available.</span>;
    }

    return (
        <div>
            {saving && (
                <div className="mb-1 flex justify-end">
                    <Spinner size="xs" />
                </div>
            )}
            {dimensionData.map(dim => {
                const selected = dim.categories.filter(c => selectedIds.has(c.id));
                return (
                    <div key={dim.id} className="mb-2">
                        <div className="mb-0.5 flex items-center gap-1">
                            <span className="text-[10px] font-bold uppercase text-slate-600">
                                {dim.label}
                            </span>
                            {selected.length > 0 && (
                                <Badge colorScheme="blue">{selected.length}</Badge>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {dim.categories.map(cat => {
                                const isSelected = selectedIds.has(cat.id);
                                return (
                                    <div
                                        key={cat.id}
                                        className={`flex cursor-pointer items-center gap-1 border px-1.5 py-0.5 ${isSelected ? 'border-blue-200 bg-blue-50 hover:bg-blue-100' : 'border-slate-200 bg-transparent hover:bg-slate-50'}`}
                                        onClick={() => toggle(cat.id)}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => toggle(cat.id)}
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                        {cat.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cat.color }} />}
                                        <span className="text-xs">{cat.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default AssetCategoriesEditor;
