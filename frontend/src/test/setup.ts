import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { server } from './server'

// ── MSW lifecycle ────────────────────────────────────────────────────────
// Start the mock network before any test, reset per-test request handlers
// after each test (so a test's `server.use(...)` override never leaks), and
// close the server when the suite finishes. `onUnhandledRequest: 'error'`
// keeps handlers honest: an un-mocked endpoint fails loudly instead of
// hitting a real backend.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
    cleanup()
    server.resetHandlers()
    localStorage.clear()
})
afterAll(() => server.close())

// ── Storage polyfill ─────────────────────────────────────────────────────
// jsdom does not expose a usable Storage implementation in this setup
// (`localStorage.clear` etc. are missing), but hooks like `usePagination`
// read/write it directly. Install a minimal in-memory Storage so those
// calls work deterministically and reset cleanly between tests.
class MemoryStorage implements Storage {
    private store = new Map<string, string>()
    get length(): number {
        return this.store.size
    }
    clear(): void {
        this.store.clear()
    }
    getItem(key: string): string | null {
        return this.store.has(key) ? (this.store.get(key) as string) : null
    }
    key(index: number): string | null {
        return Array.from(this.store.keys())[index] ?? null
    }
    removeItem(key: string): void {
        this.store.delete(key)
    }
    setItem(key: string, value: string): void {
        this.store.set(key, String(value))
    }
}

Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), writable: true })
Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), writable: true })


// ── jsdom shims ──────────────────────────────────────────────────────────
// jsdom doesn't implement these but several components reference them
// (charts/popovers measure the viewport or observe element resizes).
if (!('matchMedia' in window)) {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }),
    })
}

class ResizeObserverStub {
    observe() { }
    unobserve() { }
    disconnect() { }
}
if (!('ResizeObserver' in window)) {
    Object.defineProperty(window, 'ResizeObserver', {
        writable: true,
        value: ResizeObserverStub,
    })
}

window.scrollTo = window.scrollTo || (() => { })
