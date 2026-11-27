// Randomised differential tests: the incremental solver against the
// vertex enumeration oracle, and against a solver rebuilt from scratch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Solver, Variable, Constraint, Expression, Strength, UnsatisfiableConstraintError } from '../src/index.js';
import { bruteForce, cost, feasible, rng } from './oracle.js';

const STRENGTHS = [Strength.weak, Strength.medium, Strength.strong];

function randomLin(rand, n, forceRequired = null) {
  const coef = Array.from({ length: n }, () => (rand() < 0.6 ? Math.floor(rand() * 7) - 3 : 0));
  if (coef.every((c) => c === 0)) coef[Math.floor(rand() * n)] = 1 + Math.floor(rand() * 3);
  const required = forceRequired ?? rand() < 0.3;
  return {
    coef,
    constant: Math.floor(rand() * 41) - 20,
    op: ['<=', '>=', '=='][Math.floor(rand() * 3)],
    required,
    strength: required ? Strength.required : STRENGTHS[Math.floor(rand() * 3)],
  };
}

function toConstraint(lin, vars) {
  let e = Expression.from(lin.constant);
  lin.coef.forEach((c, i) => { if (c) e = e.plus(vars[i].times(c)); });
  return new Constraint(e, lin.op, 0, lin.strength);
}

function solutionOf(solver, vars) {
  solver.updateVariables();
  return vars.map((v) => v.value);
}

function assertMatchesOracle(lins, n, x, label) {
  const oracle = bruteForce(lins, n);
  assert.ok(oracle, `${label}: oracle found the system infeasible but solver accepted it`);
  assert.ok(feasible(lins, x), `${label}: solver violates a required constraint at ${x}`);
  const got = cost(lins, x);
  const tol = 1e-6 * Math.max(1, Math.abs(oracle.cost));
  assert.ok(Math.abs(got - oracle.cost) <= tol, `${label}: solver cost ${got} != oracle ${oracle.cost}`);
}

test('random systems: optimal cost and required feasibility match the oracle', () => {
  let rejected = 0;
  let checked = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const rand = rng(seed);
    const n = 2 + (seed % 2);
    const vars = Array.from({ length: n }, (_, i) => new Variable(`x${i}`));
    const solver = new Solver();
    const lins = [];
    // Weak stays keep the optimum at a vertex (see oracle.js).
    for (let i = 0; i < n; i++) {
      const coef = Array(n).fill(0); coef[i] = 1;
      const stay = { coef, constant: -(Math.floor(rand() * 21) - 10), op: '==', required: false, strength: Strength.weak };
      lins.push(stay);
      solver.addConstraint(toConstraint(stay, vars));
    }
    const k = 3 + Math.floor(rand() * 4);
    for (let j = 0; j < k; j++) {
      const lin = randomLin(rand, n);
      const c = toConstraint(lin, vars);
      const before = solutionOf(solver, vars);
      try {
        solver.addConstraint(c);
        lins.push(lin);
      } catch (err) {
        assert.ok(err instanceof UnsatisfiableConstraintError, `seed ${seed}: unexpected ${err}`);
        assert.equal(bruteForce([...lins, lin], n), null, `seed ${seed}: solver rejected a satisfiable constraint`);
        // Transactional failure: nothing moved and the solver still works.
        assert.deepEqual(solutionOf(solver, vars).map((v) => +v.toFixed(9)), before.map((v) => +v.toFixed(9)));
        assert.equal(solver.hasConstraint(c), false);
        rejected++;
        continue;
      }
      assertMatchesOracle(lins, n, solutionOf(solver, vars), `seed ${seed} step ${j}`);
      checked++;
    }
  }
  assert.ok(rejected > 10, `fuzzer should exercise unsatisfiable adds (got ${rejected})`);
  assert.ok(checked > 500);
});

test('random removals keep the tableau optimal', () => {
  for (let seed = 1000; seed < 1250; seed++) {
    const rand = rng(seed);
    const n = 2 + (seed % 2);
    const vars = Array.from({ length: n }, (_, i) => new Variable(`x${i}`));
    const solver = new Solver();
    const live = [];
    for (let i = 0; i < n; i++) {
      const coef = Array(n).fill(0); coef[i] = 1;
      const lin = { coef, constant: -(Math.floor(rand() * 21) - 10), op: '==', required: false, strength: Strength.weak };
      solver.addConstraint(toConstraint(lin, vars));
      live.push({ lin, c: null, stay: true });
    }
    for (let j = 0; j < 7; j++) {
      const lin = randomLin(rand, n);
      const c = toConstraint(lin, vars);
      try { solver.addConstraint(c); live.push({ lin, c }); } catch { /* unsatisfiable, skip */ }
    }
    // Remove removable constraints in random order, checking after each.
    const removable = live.filter((e) => e.c);
    while (removable.length) {
      const e = removable.splice(Math.floor(rand() * removable.length), 1)[0];
      solver.removeConstraint(e.c);
      live.splice(live.indexOf(e), 1);
      assertMatchesOracle(live.map((l) => l.lin), n, solutionOf(solver, vars), `seed ${seed} remove`);
    }
  }
});

test('edit variables: every suggestion lands on the oracle optimum', () => {
  for (let seed = 2000; seed < 2200; seed++) {
    const rand = rng(seed);
    const n = 2 + (seed % 2);
    const vars = Array.from({ length: n }, (_, i) => new Variable(`x${i}`));
    const solver = new Solver();
    const lins = [];
    for (let i = 0; i < n; i++) {
      const coef = Array(n).fill(0); coef[i] = 1;
      const lin = { coef, constant: 0, op: '==', required: false, strength: Strength.weak };
      solver.addConstraint(toConstraint(lin, vars));
      lins.push(lin);
    }
    for (let j = 0; j < 5; j++) {
      const lin = randomLin(rand, n);
      try { solver.addConstraint(toConstraint(lin, vars)); lins.push(lin); } catch { /* skip */ }
    }
    // Edit the first variable (and sometimes the second) at random strengths.
    const edits = [];
    for (let i = 0; i < (rand() < 0.5 ? 1 : 2); i++) {
      const strength = STRENGTHS[Math.floor(rand() * 3)];
      solver.addEditVariable(vars[i], strength);
      const coef = Array(n).fill(0); coef[i] = 1;
      const lin = { coef, constant: 0, op: '==', required: false, strength };
      lins.push(lin);
      edits.push({ v: vars[i], lin });
    }
    for (let step = 0; step < 8; step++) {
      for (const e of edits) {
        const value = Math.floor(rand() * 61) - 30;
        solver.suggestValue(e.v, value);
        e.lin.constant = -value;
      }
      assertMatchesOracle(lins, n, solutionOf(solver, vars), `seed ${seed} suggest ${step}`);
    }
  }
});

test('incremental result equals a solver rebuilt from scratch', () => {
  for (let seed = 3000; seed < 3150; seed++) {
    const rand = rng(seed);
    const n = 3;
    const vars = Array.from({ length: n }, (_, i) => new Variable(`x${i}`));
    const lins = [];
    for (let i = 0; i < n; i++) {
      const coef = Array(n).fill(0); coef[i] = 1;
      lins.push({ coef, constant: -(i * 5), op: '==', required: false, strength: Strength.weak });
    }
    for (let j = 0; j < 10; j++) lins.push(randomLin(rand, n, rand() < 0.2));

    const inc = new Solver();
    const kept = [];
    const handles = [];
    for (const lin of lins) {
      const c = toConstraint(lin, vars);
      try { inc.addConstraint(c); kept.push(lin); handles.push(c); } catch { /* skip */ }
    }
    // Churn: remove and re add half of them.
    for (let i = 0; i < handles.length; i += 2) inc.removeConstraint(handles[i]);
    for (let i = 0; i < handles.length; i += 2) { handles[i] = toConstraint(kept[i], vars); inc.addConstraint(handles[i]); }
    const xi = solutionOf(inc, vars);

    const fresh = new Solver();
    for (const lin of kept) fresh.addConstraint(toConstraint(lin, vars));
    const xf = solutionOf(fresh, vars);
    const tol = 1e-6 * Math.max(1, cost(kept, xf));
    assert.ok(Math.abs(cost(kept, xi) - cost(kept, xf)) <= tol, `seed ${seed}: incremental ${cost(kept, xi)} vs fresh ${cost(kept, xf)}`);
    assert.ok(Math.abs(inc.objectiveValue() - fresh.objectiveValue()) <= tol, `seed ${seed}: objective rows disagree`);
  }
});
