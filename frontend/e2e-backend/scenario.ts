import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..', '..')
const SCENARIO = 'frontend_e2e'

/**
 * Ports for the `frontend_e2e` scenario are deterministic (hash-derived from
 * the scenario name by .taskfiles/scenario_ports.sh), so we can resolve them
 * up front — before `task start:scenario:backend` has actually started
 * anything — and reuse the same values for globalSetup/globalTeardown and
 * the Playwright webServer/baseURL.
 */
export function resolveScenarioPorts(): { apiPort: number; webPort: number } {
    const output = execSync(
        `bash -c 'source .taskfiles/scenario_ports.sh "${SCENARIO}" >/dev/null 2>&1 && echo "$SC_API_PORT $SC_WEB_PORT"'`,
        { cwd: ROOT_DIR, encoding: 'utf-8' },
    ).trim()
    const [apiPort, webPort] = output.split(' ').map(Number)
    if (!apiPort || !webPort) {
        throw new Error(`Failed to resolve scenario ports for "${SCENARIO}": got "${output}"`)
    }
    return { apiPort, webPort }
}

export { ROOT_DIR, SCENARIO }
