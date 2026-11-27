#!/usr/bin/env node
// Command line front end.
//
//   cassowary solve <file.cass> [name=value ...] [format=json|table]
//       Solve a layout script. Each name=value overrides (suggests) an
//       edit variable after the script has run.
//   cassowary sweep <file.cass> <name> <from> <to> <step>
//       Re-solve incrementally while sweeping one edit variable, printing
//       every box per step; handy for checking responsive behaviour.
//   cassowary serve [port]
//       Serve the interactive demo at http://localhost:<port>/demo/.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Layout } from '../src/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(code = 1) {
  console.error(`usage:
  cassowary solve <file.cass> [name=value ...] [format=json|table]
  cassowary sweep <file.cass> <name> <from> <to> <step>
  cassowary serve [port]`);
  process.exit(code);
}

function load(file) {
  const L = new Layout();
  L.run(readFileSync(file, 'utf8'));
  return L;
}

function table(L) {
  const rows = Object.entries(L.rects());
  const w = Math.max(4, ...rows.map(([n]) => n.length));
  const pad = (s, n) => String(s).padStart(n);
  const lines = [`${'box'.padEnd(w)} ${pad('left', 9)} ${pad('top', 9)} ${pad('width', 9)} ${pad('height', 9)}`];
  for (const [n, r] of rows) lines.push(`${n.padEnd(w)} ${pad(r.left, 9)} ${pad(r.top, 9)} ${pad(r.width, 9)} ${pad(r.height, 9)}`);
  const v = L.violations();
  if (v.length) {
    lines.push('', 'relaxed (non required constraints not fully met):');
    for (const x of v) lines.push(`  ${x.constraint}  off by ${x.amount}`);
  }
  return lines.join('\n');
}

function solve(args) {
  const [file, ...rest] = args;
  if (!file) usage();
  let format = 'table';
  const L = load(file);
  for (const a of rest) {
    const m = /^([A-Za-z_][\w.]*)=(.+)$/.exec(a);
    if (!m) usage();
    if (m[1] === 'format') { format = m[2]; continue; }
    L.suggest(m[1], Number(m[2]));
  }
  L.solve();
  if (format === 'json') {
    console.log(JSON.stringify({ boxes: L.rects(), values: L.values(), relaxed: L.violations() }, null, 2));
  } else {
    console.log(table(L));
  }
}

function sweep(args) {
  const [file, name, from, to, step] = args;
  if (!step) usage();
  const L = load(file);
  const a = Number(from), b = Number(to), s = Math.abs(Number(step)) * Math.sign(b - a || 1);
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let x = a; s > 0 ? x <= b : x >= b; x += s) {
    L.suggest(name, x);
    const rects = L.rects();
    n++;
    console.log(`${name}=${x}  ` + Object.entries(rects).map(([k, r]) => `${k}[${r.left},${r.top} ${r.width}x${r.height}]`).join(' '));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.error(`${n} incremental solves in ${ms.toFixed(1)} ms`);
}

function serve(args) {
  const port = Number(args[0] ?? 8080);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.cass': 'text/plain' };
  createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') { res.writeHead(302, { Location: '/demo/' }); return res.end(); }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }).listen(port, () => console.log(`demo running at http://localhost:${port}/demo/`));
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'solve') solve(args);
  else if (cmd === 'sweep') sweep(args);
  else if (cmd === 'serve') serve(args);
  else usage(cmd ? 1 : 0);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(2);
}
