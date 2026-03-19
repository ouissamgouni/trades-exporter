/**
 * Utility functions for duplicate detection tags on transactions.
 * Extracted from TransactionsTable for reuse.
 */

import type { Transaction } from '../types';

export const getDuplicateTags = (tx: Transaction): any[] => {
    if (!tx.tags || typeof tx.tags !== 'object') return [];

    if (Array.isArray(tx.tags)) {
        return tx.tags;
    }

    const tagArray = (tx.tags as any).tags || Object.values(tx.tags);
    return Array.isArray(tagArray) ? tagArray : [];
};

export const hasPotentialDuplicateTag = (tx: Transaction): boolean => {
    const tags = getDuplicateTags(tx);
    return tags.some((tag: any) =>
        tag && typeof tag === 'object' && (tag.dup_group || tag.sys_group)
    );
};

export const getDuplicateResolutionTag = (tx: Transaction): any | null => {
    const tags = getDuplicateTags(tx);

    const resolutionTag = tags.find((tag: any) =>
        tag && typeof tag === 'object' && (tag.sys_resolution || tag.dup_resolution)
    );
    if (resolutionTag) {
        return {
            dup_resolution: resolutionTag.sys_resolution || resolutionTag.dup_resolution,
            group_hash: tags.find((t: any) => t?.sys_group || t?.dup_group)?.sys_group
                || tags.find((t: any) => t?.dup_group)?.dup_group,
            dup_resolved_at: tags.find((t: any) => t?.sys_resolved_at || t?.dup_resolved_at)?.sys_resolved_at
                || tags.find((t: any) => t?.dup_resolved_at)?.dup_resolved_at,
        };
    }

    return null;
};

export const getDuplicateGroupHash = (tx: Transaction): string | null => {
    const tags = getDuplicateTags(tx);

    const groupTag = tags.find((tag: any) =>
        tag && typeof tag === 'object' && (tag.sys_group || tag.dup_group)
    );
    return groupTag?.sys_group || groupTag?.dup_group || null;
};
