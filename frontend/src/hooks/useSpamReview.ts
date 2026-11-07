import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Transaction } from '../types';
import { toaster } from '../components/ui/toaster';

export type SpamVerdict = 'allow' | 'block';

export const SUSPECTED_SPAM_TAG = 'spam_level:suspected';

/** 'suspected' for the unsolicited-unpriced heuristic, 'confirmed' for other auto/user spam flags. */
export const getSpamLevel = (tx: Pick<Transaction, 'tags'>): 'suspected' | 'confirmed' | null => {
    const tags: unknown[] = Array.isArray(tx.tags) ? tx.tags : tx.tags ? [tx.tags] : [];
    const tag = tags.find(t => t && typeof t === 'object' && (t as Record<string, unknown>).spam) as
        Record<string, unknown> | undefined;
    if (!tag) return null;
    return tag.spam_level === 'suspected' ? 'suspected' : 'confirmed';
};

export function useSuspectedSpamCount() {
    const { data } = useQuery({
        queryKey: ['spamSummary'],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/spam/summary`);
            if (!response.ok) return { suspected_count: 0 };
            return response.json() as Promise<{ suspected_count: number }>;
        },
        staleTime: 30_000,
    });
    return data?.suspected_count ?? 0;
}

/** Applies a per-token verdict; one call per distinct token among the given transactions. */
export function useSpamVerdict() {
    const queryClient = useQueryClient();
    const [isApplying, setIsApplying] = useState(false);

    const applyVerdict = useCallback(async (txs: Transaction[], verdict: SpamVerdict) => {
        const byToken = new Map<string, Transaction>();
        txs.forEach(tx => {
            if (!tx.token_contract_address) return;
            const key = `${(tx.network || '').toLowerCase()}:${tx.token_contract_address.toLowerCase()}`;
            if (!byToken.has(key)) byToken.set(key, tx);
        });
        if (byToken.size === 0) {
            toaster.warning({ title: 'No token contract on the selected rows' });
            return;
        }

        setIsApplying(true);
        let updated = 0;
        try {
            for (const tx of byToken.values()) {
                const response = await fetch(`${API_URL}/spam/verdict`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transaction_id: tx.id, verdict }),
                });
                if (!response.ok) throw new Error(`Verdict failed for ${tx.source_asset_symbol}`);
                updated += (await response.json()).updated_count as number;
            }
            toaster.success({
                title: verdict === 'allow' ? 'Marked as not spam' : 'Confirmed as spam',
                description: `${byToken.size} token(s), ${updated} transaction(s) updated`,
            });
        } catch (err) {
            toaster.error({ title: err instanceof Error ? err.message : 'Verdict failed' });
        } finally {
            setIsApplying(false);
            queryClient.invalidateQueries({ queryKey: ['transactions'], refetchType: 'active' });
            queryClient.invalidateQueries({ queryKey: ['spamSummary'] });
        }
    }, [queryClient]);

    return { applyVerdict, isApplying };
}
