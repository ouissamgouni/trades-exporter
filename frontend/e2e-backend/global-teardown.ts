import { execSync } from 'node:child_process'
import { ROOT_DIR, SCENARIO } from './scenario'

/**
 * Tears down the `frontend_e2e` scenario (DB container + detached backend
 * process) after the backend-backed Playwright suite finishes.
 */
export default function globalTeardown() {
    console.log(`[global-teardown] Stopping scenario "${SCENARIO}"...`)
    try {
        execSync(`task stop:scenario SCENARIO=${SCENARIO} --yes`, {
            cwd: ROOT_DIR,
            stdio: 'inherit',
        })
    } catch (err) {
        console.warn(`[global-teardown] Failed to stop scenario "${SCENARIO}":`, err)
    }
}
