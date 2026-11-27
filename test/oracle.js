// An independent, deliberately naive oracle for small constraint systems.
//
// The Cassowary objective (sum of strength * violation over non required
// constraints, subject to the required ones) is a convex piecewise linear
// function. Its minimum over a pointed polyhedron is attained at a vertex
// of the hyperplane arrangement formed by all constraint boundaries. So for
// n variables we try every n subset of boundaries, solve the n x n system
// by Gaussian elimination, keep the points that satisfy every required
// constraint, and take the cheapest one. Exponential, but exact enough and
// shares no code with the simplex tableau.
//
// The fuzz tests always include an equality stay on every variable, which
// guarantees the boundary normals span R^n and therefore that a vertex
// optimum exists.

export const TOL = 1e-6;

/**
 * @typedef {{coef: number[], constant: number, op: '<='|'>='|'==', strength: number, required: boolean}} Lin
 * Each Lin means  coef . x + constant  op  0.
 */

function evalLin(c, x) {
  let s = c.constant;
  for (let i = 0; i < x.length; i++) s += c.coef[i] * x[i];
  return s;
}

export function violation(c, x) {
  const e = evalLin(c, x);
  if (c.op === '==') return Math.abs(e);
  if (c.op === '<=') return Math.max(0, e);
  return Math.max(0, -e);
}

export function cost(cons, x) {
  let s = 0;
  for (const c of cons) if (!c.required) s += c.strength * violation(c, x);
  return s;
}

export function feasible(cons, x, tol = TOL) {
  for (const c of cons) {
    if (!c.required) continue;
    const scale = 1 + c.coef.reduce((a, b) => a + Math.abs(b), 0) + Math.abs(c.constant);
    if (violation(c, x) > tol * scale) return false;
  }
  return true;
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function* subsets(m, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < m; i++) {
    acc.push(i);
    yield* subsets(m, k, i + 1, acc);
    acc.pop();
  }
}

/** @returns {{x: number[], cost: number} | null} null when the required set is infeasible */
export function bruteForce(cons, n) {
  let best = null;
  for (const idx of subsets(cons.length, n)) {
    const A = idx.map((i) => cons[i].coef);
    const b = idx.map((i) => -cons[i].constant);
    const x = solveLinear(A, b);
    if (!x || !feasible(cons, x)) continue;
    const v = cost(cons, x);
    if (!best || v < best.cost) best = { x, cost: v };
  }
  return best;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible from the seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
