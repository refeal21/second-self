# Desktop development boundary

`pnpm dev` starts the Tauri development shell and Vite binds only to `127.0.0.1:1420` for local development and browser visual QA. Packaged Tauri builds embed `../dist` through `frontendDist`; they do not depend on a running HTTP server or expose a backend/API port.
