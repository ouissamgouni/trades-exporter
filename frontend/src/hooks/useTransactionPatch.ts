import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, Transaction } from '../types';

// Fields that need parseFloat before sending to API
const NUMERIC_FIELDS = new Set(['quantity', 'price', 'fee', 'total']);

/**
 * useTransactionPatch - Hook for patching individual transaction fields via the API.
 *
 * Uses PATCH /transactions/{id} with partial updates (only changed fields).
 * Automatically handles:
 * - Numeric field conversion (string → float)
 * - Tag serialization ({key, value}[] → [{key: value}])
 * - Query cache invalidation after successful patch
 */
export function useTransactionPatch(transactionId: number) {
    const queryClient = useQueryClient();
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Patch a single field on the transaction.
     */
    const patchField = useCallback(async (
        field: string,
        value: any,
    ): Promise<Transaction> => {
        return patchFields({ [field]: value });
    }, [transactionId]);

    /**
     * Patch multiple fields at once (for interdependent updates like price+total).
     */
    const patchFields = useCallback(async (
        updates: Record<string, any>,
    ): Promise<Transaction> => {
        setIsSaving(true);
        setError(null);

        try {
            // Build payload with proper type conversions
            const payload: Record<string, any> = {};

            for (const [field, value] of Object.entries(updates)) {
                if (NUMERIC_FIELDS.has(field)) {
                    const num = parseFloat(value);
                    if (!isNaN(num)) {
                        payload[field] = num;
                    }
                } else if (field === 'tags' && Array.isArray(value)) {
                    // Convert from {key, value}[] format to [{key: value}] format if needed
                    payload.tags = value.map((tag: any) => {
                        if ('key' in tag && 'value' in tag) {
                            return { [tag.key]: tag.value };
                        }
                        return tag; // Already in {key: value} format
                    });
                } else if (field === 'include_fee' || field === 'disposal_taxable') {
                    // Handle boolean fields that may come as strings
                    payload[field] = typeof value === 'string' ? value === 'true' : !!value;
                } else if (field === 'account_id' || field === 'asset_id' || field === 'price_quote_asset_id' ||
                    field === 'fee_quote_asset_id' || field === 'from_account_id' || field === 'to_account_id') {
                    // ID fields: parse as int or null
                    payload[field] = value ? parseInt(String(value), 10) : null;
                } else {
                    payload[field] = value;
                }
            }

            const response = await fetch(`${API_URL}/transactions/${transactionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || 'Failed to update transaction');
            }

            const updatedTransaction: Transaction = await response.json();

            // Invalidate transaction queries to refresh any tables/lists
            queryClient.invalidateQueries({ queryKey: ['transactions'] });

            return updatedTransaction;
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update transaction';
            setError(message);
            throw err;
        } finally {
            setIsSaving(false);
        }
    }, [transactionId, queryClient]);

    return {
        patchField,
        patchFields,
        isSaving,
        error,
    };
}
