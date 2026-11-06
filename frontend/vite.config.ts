import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'

// Docker builds pass VITE_APP_VERSION; local dev falls back to git describe.
function appVersion(): string {
    if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
    try {
        return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim()
    } catch {
        return 'dev'
    }
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
        'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()),
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 3002,
        open: true,
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
})
