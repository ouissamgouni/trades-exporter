import { execSync } from 'node:child_process'
import { ROOT_DIR, SCENARIO } from './scenario'

/**
 * Starts the dedicated `frontend_e2e` scenario (DB + backend only, detached,
 * in the background) before the backend-backed Playwright suite runs.
 * RESET=1 ensures a fresh, deterministic DB on every run.
 */
export default function globalSetup() {
    console.log(`[global-setup] Starting scenario "${SCENARIO}" (detached)...`)
    execSync(`task start:scenario:backend SCENARIO=${SCENARIO} RESET=1`, {
        cwd: ROOT_DIR,
        stdio: 'inherit',
    })
}
