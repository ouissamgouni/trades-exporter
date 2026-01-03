# Trades Exporter React (No Next.js)

## How to Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

- `public/index.html` — HTML entry point
- `src/index.tsx` — React entry point
- `src/App.tsx` — Main App component (migrated from Next.js)
- `webpack.config.js` — Webpack config for dev/build
- `tsconfig.json` — TypeScript config

## Migration Notes

- All logic/UI from your previous Next.js `page.tsx` will be in `src/App.tsx`.
- No server-side rendering, just pure React SPA.
- You can use the same API endpoints as before.
