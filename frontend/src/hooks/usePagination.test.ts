import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePagination, DEFAULT_PAGE_SIZE, getPersistedPageSize } from './usePagination'

// Major: pagination state/localStorage-persistence is shared across every
// paginated table in the app (transactions, positions, prices, etc.) — a
// regression here corrupts page navigation app-wide.
describe('usePagination', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('defaults to page 1 and the default page size', () => {
        const { result } = renderHook(() => usePagination())
        expect(result.current.page).toBe(1)
        expect(result.current.pageSize).toBe(DEFAULT_PAGE_SIZE)
    })

    it('computes derived pagination state from an externally supplied total (server-side mode)', () => {
        const { result } = renderHook(() => usePagination({ totalItems: 120, initialPageSize: 50 }))

        expect(result.current.totalPages).toBe(3)
        expect(result.current.startItem).toBe(1)
        expect(result.current.endItem).toBe(50)
        expect(result.current.hasNextPage).toBe(true)
        expect(result.current.hasPrevPage).toBe(false)
    })

    it('advances and rewinds pages', () => {
        const { result } = renderHook(() => usePagination({ totalItems: 120, initialPageSize: 50 }))

        act(() => result.current.nextPage())
        expect(result.current.page).toBe(2)
        expect(result.current.startItem).toBe(51)
        expect(result.current.endItem).toBe(100)

        act(() => result.current.prevPage())
        expect(result.current.page).toBe(1)
    })

    it('does not advance past the last page', () => {
        const { result } = renderHook(() => usePagination({ totalItems: 120, initialPageSize: 50 }))

        act(() => result.current.lastPage())
        expect(result.current.page).toBe(3)
        act(() => result.current.nextPage())
        expect(result.current.page).toBe(3)
    })

    it('resets to page 1 when the page size changes', () => {
        const { result } = renderHook(() => usePagination({ totalItems: 120, initialPageSize: 50 }))

        act(() => result.current.nextPage())
        expect(result.current.page).toBe(2)

        act(() => result.current.setPageSize(100))
        expect(result.current.page).toBe(1)
        expect(result.current.pageSize).toBe(100)
    })

    it('paginates a client-side array to the current page window', () => {
        const items = Array.from({ length: 25 }, (_, i) => i)
        const { result } = renderHook(() => usePagination({ initialPageSize: 10 }))

        let firstPage: number[] = []
        act(() => {
            firstPage = result.current.paginate(items)
        })
        expect(firstPage).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    })

    it('persists page size to localStorage under the given storage key', () => {
        const { result } = renderHook(() => usePagination({ storageKey: 'test-table', initialPageSize: 25 }))

        act(() => result.current.setPageSize(100))

        expect(getPersistedPageSize('test-table')).toBe(100)
    })
})
