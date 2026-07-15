import { http, HttpResponse } from 'msw'

// Wildcard origin (`*`) so handlers intercept requests regardless of which
// API_URL branch resolves under jsdom (VITE_API_URL vs. the window.location
// .port-based fallback in types.ts).
export const handlers = [
    http.get('*/data-health/duplicate-suspicions', () => {
        return HttpResponse.json({ suspicions: [] })
    }),
]
