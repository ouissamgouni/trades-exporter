import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { useDuplicateMap } from './useDuplicateMap'

// Major: builds the O(1) transaction-id -> duplicate-group lookup rendered
// as inline indicators in the transactions table. Demonstrates the
// MSW + React Query hook-testing harness (reusable for other data-fetching
// hooks, e.g. usePnLData, which is deeply coupled to PnLContext's reducer
// and out of scope for a standalone hook test).
function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useDuplicateMap', () => {
    it('returns an empty map when there are no duplicate suspicions', async () => {
        const { result } = renderHook(() => useDuplicateMap(), { wrapper: createWrapper() })

        await waitFor(() => expect(result.current.isLoading).toBe(false))

        expect(result.current.duplicateMap.size).toBe(0)
        expect(result.current.getGroupTxIds(123)).toEqual([])
    })

    it('builds a lookup map keyed by transaction ID for each duplicate group', async () => {
        server.use(
            http.get('*/data-health/duplicate-suspicions', () =>
                HttpResponse.json({
                    suspicions: [
                        { group_hash: 'a', transaction_ids: [1, 2], match_criteria: 'same amount + date' },
                        { group_hash: 'b', transaction_ids: [3], match_criteria: 'same hash' },
                    ],
                }),
            ),
        )

        const { result } = renderHook(() => useDuplicateMap(), { wrapper: createWrapper() })

        await waitFor(() => expect(result.current.duplicateMap.size).toBe(3))

        expect(result.current.getGroupTxIds(1)).toEqual([1, 2])
        expect(result.current.getGroupTxIds(3)).toEqual([3])
        expect(result.current.duplicateMap.get(1)?.groupHash).toBe('a')
        expect(result.current.duplicateMap.get(3)?.groupHash).toBe('b')
    })

    it('does not fetch when disabled', () => {
        const { result } = renderHook(() => useDuplicateMap(false), { wrapper: createWrapper() })

        expect(result.current.isLoading).toBe(false)
        expect(result.current.suspicions).toEqual([])
    })
})
