# TradeTrail Frontend

The TradeTrail web app: a Vite + React + TypeScript single-page application that
talks to the FastAPI backend.

## Tech stack

- [Vite](https://vitejs.dev/) build tooling and dev server
- React 18 + TypeScript
- Tailwind CSS (via `@tailwindcss/vite`)
- Chakra UI, Radix UI, and Nivo charts
- TanStack Query and TanStack Table

## Running the frontend

Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

The dev server runs on the port configured in [vite.config.ts](vite.config.ts)
(`3002` by default) and opens automatically.

Other scripts:

```bash
npm run build     # type-check and produce a production build in dist/
npm run preview   # preview the production build locally
```

For the full local stack (backend + frontend together), use the Task-based
workflow from the repository root instead:

```bash
task start:dev
```

See the root [README](../README.md) and
[docs/DEVELOPMENT_WORKFLOW.md](../docs/DEVELOPMENT_WORKFLOW.md) for details.

## Project structure

```text
index.html          HTML entry point
vite.config.ts      Vite configuration (dev port, aliases, build)
src/
  index.tsx         React entry point
  App.tsx           Root application component
  components/       Reusable UI components
  contexts/         React context providers
  hooks/            Custom hooks
  lib/, utils/      Shared helpers
  constants/, enums.ts, types.ts
```

The `@` alias resolves to `src/` (see `vite.config.ts`).

## License

Part of TradeTrail, licensed under AGPL-3.0-or-later. See the
[LICENSE](../LICENSE) file at the repository root.
