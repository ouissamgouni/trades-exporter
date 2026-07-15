import { setupServer } from 'msw/node'
import { handlers } from './handlers'

// The shared MSW server instance used across the whole Vitest run.
// Individual tests refine behaviour per-case via `server.use(...)`.
export const server = setupServer(...handlers)
