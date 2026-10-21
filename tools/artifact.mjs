// Builds a one-file preview of the editor (script and styles inlined, analysis on the main thread
// because there is no worker file next to it): .cache/artifact.html. For sharing a build before deploy.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const commit = execSync('git rev-parse --short HEAD').toString().trim();
const js = buildSync({ entryPoints: ['src/main.ts'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2022', logLevel: 'error',
  define: { __BUILD__: JSON.stringify(`${commit} · preview`) } }).outputFiles[0].text;
const css = fs.readFileSync('src/style.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
const out = `<title>Music Looper</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${css}</style>\n${body}<script>${js.replace(/<\/script>/g, '<\\/script>')}</script>\n`;
fs.mkdirSync('.cache', { recursive: true });
fs.writeFileSync('.cache/artifact.html', out);
console.log('.cache/artifact.html', (out.length / 1024).toFixed(0), 'kB');
