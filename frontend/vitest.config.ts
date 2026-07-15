import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Vitest configuration is kept separate from vite.config.ts so the app
// build (tsc && vite build) never pulls in test-only globals.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        css: false,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        // Playwright e2e specs live under e2e/ and run with their own runner.
        exclude: ['node_modules', 'dist', 'e2e'],
        restoreMocks: true,
        clearMocks: true,
    },
})
