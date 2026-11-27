// Why incremental? Compare re-solving a resize by suggesting a new window
// width (dual simplex, warm tableau) against rebuilding the whole system
// from scratch for every frame.
//
//   node bench/bench.js [columns] [frames]

import { Layout } from '../src/index.js';

const N = Number(process.argv[2] ?? 60);
const FRAMES = Number(process.argv[3] ?? 200);

function script(width) {
  const lines = ['box win', 'win.left == 0', 'win.top == 0', 'win.height == 600', `suggest win.width = ${width}`];
  for (let i = 0; i < N; i++) {
    lines.push(`box c${i}`, `c${i}.top == 8`, `c${i}.bottom == win.bottom - 8`, `c${i}.width >= 20`, `c${i}.width == 120 @medium`);
    lines.push(i === 0 ? 'c0.left == win.left + 8' : `c${i}.left == c${i - 1}.right + 8`);
    if (i > 0 && i % 3 === 0) lines.push(`c${i}.width == c${i - 1}.width @weak`);
  }
  lines.push(`c${N - 1}.right <= win.right - 8`);
  return lines.join('\n');
}

const widths = Array.from({ length: FRAMES }, (_, f) => 2000 + 4000 * Math.sin(f / 15) ** 2);
const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

let L;
const build = time(() => { L = new Layout(); L.run(script(widths[0])); });
const constraints = L.solver.constraintCount;
const incr = time(() => { for (const w of widths) { L.suggest('win.width', w); L.solve(); } });
const incrResult = L.rect(`c${N - 1}`);

let R;
const frames = Math.min(FRAMES, 30);
const rebuild = time(() => { for (let f = 0; f < frames; f++) { R = new Layout(); R.run(script(widths[f])); } });

console.log(`${N} columns, ${constraints} constraints`);
console.log(`initial build              ${build.toFixed(1)} ms`);
console.log(`incremental resize         ${(incr / FRAMES).toFixed(3)} ms / frame  (${FRAMES} frames)`);
console.log(`rebuild from scratch       ${(rebuild / frames).toFixed(3)} ms / frame  (${frames} frames)`);
console.log(`speedup                    ${(rebuild / frames / (incr / FRAMES)).toFixed(0)}x`);
console.log(`last column after sweep    ${JSON.stringify(incrResult)}`);
