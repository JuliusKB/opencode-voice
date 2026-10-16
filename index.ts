// Entrypoint shim: opencode resolves local directory plugins by root-level
// `server`/`index` (server half) and `tui` (TUI half) files, not package.json
// exports. Real code lives in src/.
export { default } from "./src/index"
