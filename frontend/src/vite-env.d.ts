/// <reference types="vite/client" />

/**
 * Type declarations for Vite environment variables
 * These are injected at build time via --build-arg in Docker builds
 */
interface ImportMetaEnv {
    /**
     * Backend API URL
     * - Dev: http://localhost:8000
     * - Test: http://localhost:8001
     * - Prod: http://localhost:8080
     */
    readonly VITE_API_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
