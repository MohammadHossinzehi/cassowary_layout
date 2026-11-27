import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Solver, Variable, Constraint, Strength, eq, le, ge,
  UnsatisfiableConstraintError, DuplicateConstraintError, UnknownConstraintError,
  DuplicateEditVariableError, UnknownEditVariableError, BadRequiredStrengthError,
} from '../src/index.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-7, `${msg ?? ''} expected ${b}, got ${a}`);

test('solves a simple equality system', () => {
  const s = new Solver();
  const x = new Variable('x');
  const y = new Variable('y');
  s.addConstraint(eq(x, 20));
  s.addConstraint(eq(x.plus(2), y.plus(10)));
  s.updateVariables();
  close(x.value, 20);
  close(y.value, 12);
});

test('inequalities with competing weak preferences', () => {
  const s = new Solver();
  const x = new Variable('x');
  s.addConstraint(le(x, 100));
  s.addConstraint(ge(x, 10));
  s.addConstraint(eq(x, 500, 'weak'));
  s.updateVariables();
  close(x.value, 100);
  close(s.objectiveValue(), 400 * Strength.weak);
});

test('strengths are lexicographic: one strong beats many weak', () => {
  const s = new Solver();
  const x = new Variable('x');
  for (let i = 0; i < 500; i++) s.addConstraint(eq(x, 0, 'weak'));
  s.addConstraint(eq(x, 10, 'strong'));
  s.updateVariables();
  close(x.value, 10);
});

test('medium beats weak, strong beats medium', () => {
  const s = new Solver();
  const x = new Variable('x');
  s.addConstraint(eq(x, 1, 'weak'));
  s.addConstraint(eq(x, 2, 'medium'));
  s.updateVariables();
  close(x.value, 2);
  const c = s.addConstraint(eq(x, 3, 'strong'));
  s.updateVariables();
  close(x.value, 3);
  s.removeConstraint(c);
  s.updateVariables();
  close(x.value, 2);
});

test('conflicting required constraints throw and leave the solver untouched', () => {
  const s = new Solver();
  const x = new Variable('x');
  const y = new Variable('y');
  s.addConstraint(eq(x.plus(y), 10));
  s.addConstraint(ge(x, 4));
  s.addConstraint(ge(y, 4));
  s.addConstraint(eq(x, 5, 'weak'));
  s.updateVariables();
  const before = [x.value, y.value];
  const bad = ge(x, 7);
  assert.throws(() => s.addConstraint(bad), UnsatisfiableConstraintError);
  assert.equal(s.hasConstraint(bad), false);
  s.updateVariables();
  assert.deepEqual([x.value, y.value], before);
  // And it still accepts a satisfiable one afterwards.
  s.addConstraint(ge(x, 6));
  s.updateVariables();
  close(x.value, 6);
  close(y.value, 4);
});

test('a required constraint on constants only', () => {
  const s = new Solver();
  assert.throws(() => s.addConstraint(new Constraint(1, '==', 2)), UnsatisfiableConstraintError);
  s.addConstraint(new Constraint(3, '==', 3)); // trivially fine
  s.addConstraint(new Constraint(1, '<=', 2));
  assert.throws(() => s.addConstraint(new Constraint(5, '<=', 2)), UnsatisfiableConstraintError);
});

test('redundant required equalities are accepted', () => {
  const s = new Solver();
  const x = new Variable('x');
  const y = new Variable('y');
  s.addConstraint(eq(x, y));
  s.addConstraint(eq(y, x)); // linearly dependent
  s.addConstraint(eq(x.times(2), y.times(2)));
  s.addConstraint(eq(x, 7));
  s.updateVariables();
  close(y.value, 7);
});

test('error types', () => {
  const s = new Solver();
  const x = new Variable('x');
  const c = eq(x, 1);
  s.addConstraint(c);
  assert.throws(() => s.addConstraint(c), DuplicateConstraintError);
  assert.throws(() => s.removeConstraint(eq(x, 1)), UnknownConstraintError);
  assert.throws(() => s.suggestValue(x, 1), UnknownEditVariableError);
  assert.throws(() => s.removeEditVariable(x), UnknownEditVariableError);
  assert.throws(() => s.addEditVariable(x, 'required'), BadRequiredStrengthError);
  const y = new Variable('y');
  s.addEditVariable(y, 'strong');
  assert.throws(() => s.addEditVariable(y), DuplicateEditVariableError);
  assert.throws(() => s.addConstraint('x == 1'), TypeError);
});

test('edit variables follow suggestions and respect required bounds', () => {
  const s = new Solver();
  const x = new Variable('x');
  const y = new Variable('y');
  s.addConstraint(eq(y, x.times(2)));
  s.addConstraint(le(x, 50));
  s.addEditVariable(x, 'strong');
  for (const v of [10, -5, 33.5, 80, 0]) {
    s.suggestValue(x, v);
    s.updateVariables();
    close(x.value, Math.min(v, 50), `suggest ${v}`);
    close(y.value, 2 * Math.min(v, 50));
  }
  s.removeEditVariable(x);
  assert.equal(s.hasEditVariable(x), false);
});

test('two competing edit variables resolve by strength', () => {
  const s = new Solver();
  const left = new Variable('left');
  const right = new Variable('right');
  s.addConstraint(eq(right.minus(left), 100)); // fixed width
  s.addEditVariable(left, 'medium');
  s.addEditVariable(right, 'strong');
  s.suggestValue(left, 0);
  s.suggestValue(right, 300);
  s.updateVariables();
  close(right.value, 300);
  close(left.value, 200);
});

test('drag simulation: many suggestions stay cheap and correct', () => {
  const s = new Solver();
  const vars = Array.from({ length: 40 }, (_, i) => new Variable(`x${i}`));
  for (let i = 1; i < vars.length; i++) {
    s.addConstraint(ge(vars[i], vars[i - 1].plus(10)));
    s.addConstraint(eq(vars[i], i * 10, 'weak'));
  }
  s.addConstraint(ge(vars[0], 0));
  s.addEditVariable(vars[20], 'strong');
  const pivotsBefore = s.stats.pivots + s.stats.dualPivots;
  for (let t = 0; t <= 100; t++) {
    const target = 200 + 150 * Math.sin(t / 10);
    s.suggestValue(vars[20], target);
    s.updateVariables();
    close(vars[20].value, Math.max(target, 200));
    for (let i = 1; i < vars.length; i++) assert.ok(vars[i].value >= vars[i - 1].value + 10 - 1e-7);
  }
  const perSuggest = (s.stats.pivots + s.stats.dualPivots - pivotsBefore) / 101;
  assert.ok(perSuggest < 40, `expected few pivots per suggestion, got ${perSuggest}`);
});

test('degenerate stacks of identical constraints do not cycle', () => {
  const s = new Solver();
  const v = Array.from({ length: 6 }, (_, i) => new Variable(`v${i}`));
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 5; i++) {
      s.addConstraint(le(v[i], v[i + 1]));
      s.addConstraint(eq(v[i], v[i + 1], 'weak'));
      s.addConstraint(ge(v[i].plus(v[i + 1]), 0, 'medium'));
    }
  }
  s.addConstraint(eq(v[0], 0));
  s.addConstraint(eq(v[5], 0));
  s.updateVariables();
  for (const x of v) close(x.value, 0);
});

test('reset clears everything', () => {
  const s = new Solver();
  const x = new Variable('x');
  s.addConstraint(eq(x, 3));
  s.addEditVariable(new Variable('e'));
  s.reset();
  assert.equal(s.constraintCount, 0);
  s.addConstraint(eq(x, 4));
  s.updateVariables();
  close(x.value, 4);
});
