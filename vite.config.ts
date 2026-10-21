import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// A version stamp (commit and build date), so it is easy to see which build is live.
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return (process.env.WORKERS_CI_COMMIT_SHA || 'dev').slice(0, 7); }
})();

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  define: { __BUILD__: JSON.stringify(`${commit} · ${new Date().toISOString().slice(0, 10)}`) },
  build: { target: 'es2022' },
});
