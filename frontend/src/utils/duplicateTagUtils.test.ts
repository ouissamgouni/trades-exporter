import { describe, it, expect } from 'vitest'
import type { Transaction } from '../types'
import {
    getDuplicateTags,
    hasPotentialDuplicateTag,
    getDuplicateResolutionTag,
    getDuplicateGroupHash,
} from './duplicateTagUtils'

// Critical: these helpers drive duplicate-transaction detection/resolution
// indicators in the transactions table — wrong parsing hides real duplicates
// or flags healthy transactions as duplicates.
function tx(tags: unknown): Transaction {
    return { tags } as unknown as Transaction
}

describe('getDuplicateTags', () => {
    it('returns an empty array when tags is missing or not an object', () => {
        expect(getDuplicateTags(tx(undefined))).toEqual([])
        expect(getDuplicateTags(tx(null))).toEqual([])
    })

    it('returns the array as-is when tags is already an array', () => {
        const tags = [{ sys_group: 'g1' }]
        expect(getDuplicateTags(tx(tags))).toBe(tags)
    })

    it('unwraps a `{ tags: [...] }` object shape', () => {
        const inner = [{ sys_group: 'g1' }]
        expect(getDuplicateTags(tx({ tags: inner }))).toBe(inner)
    })

    it('falls back to Object.values when tags is a plain keyed object', () => {
        const result = getDuplicateTags(tx({ a: { sys_group: 'g1' }, b: { sys_group: 'g2' } }))
        expect(result).toEqual([{ sys_group: 'g1' }, { sys_group: 'g2' }])
    })
})

describe('hasPotentialDuplicateTag', () => {
    it('is false when no tag carries a dup/sys group', () => {
        expect(hasPotentialDuplicateTag(tx([{ some: 'tag' }]))).toBe(false)
    })

    it('is true when a tag carries a sys_group or dup_group', () => {
        expect(hasPotentialDuplicateTag(tx([{ sys_group: 'g1' }]))).toBe(true)
        expect(hasPotentialDuplicateTag(tx([{ dup_group: 'g1' }]))).toBe(true)
    })
})

describe('getDuplicateResolutionTag', () => {
    it('returns null when no resolution tag exists', () => {
        expect(getDuplicateResolutionTag(tx([{ sys_group: 'g1' }]))).toBeNull()
    })

    it('extracts resolution + group hash + resolved-at from the tag set', () => {
        const tags = [
            { sys_group: 'g1', sys_resolved_at: '2024-01-01T00:00:00Z' },
            { sys_resolution: 'kept' },
        ]
        expect(getDuplicateResolutionTag(tx(tags))).toEqual({
            dup_resolution: 'kept',
            group_hash: 'g1',
            dup_resolved_at: '2024-01-01T00:00:00Z',
        })
    })
})

describe('getDuplicateGroupHash', () => {
    it('returns null when there is no group tag', () => {
        expect(getDuplicateGroupHash(tx([]))).toBeNull()
    })

    it('returns the sys_group/dup_group value', () => {
        expect(getDuplicateGroupHash(tx([{ sys_group: 'g1' }]))).toBe('g1')
        expect(getDuplicateGroupHash(tx([{ dup_group: 'g2' }]))).toBe('g2')
    })
})
