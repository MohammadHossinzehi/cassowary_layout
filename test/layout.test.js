import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Layout, parseConstraint, ParseError, Strength, Variable } from '../src/index.js';

const resolver = () => {
  const m = new Map();
  return (n) => { if (!m.has(n)) m.set(n, new Variable(n)); return m.get(n); };
};

test('parser: precedence, unary minus, parentheses, strengths', () => {
  const c = parseConstraint('-(a + 2) * 3 + b / 2 <= 4 - a @medium*3', resolver());
  // lhs - rhs = -3a - 6 + b/2 - 4 + a = -2a + 0.5b - 10
  const t = Object.fromEntries([...c.expression.terms].map(([v, k]) => [v.name, k]));
  assert.deepEqual(t, { a: -2, b: 0.5 });
  assert.equal(c.expression.constant, -10);
  assert.equal(c.op, '<=');
  assert.equal(c.strength, Strength.medium * 3);
  assert.equal(parseConstraint('x = 1', resolver()).op, '==');
  assert.equal(parseConstraint('x >= 1 @ 250', resolver()).strength, 250);
  assert.equal(parseConstraint('x >= 1', resolver()).strength, Strength.required);
  assert.equal(parseConstraint('box.left == 1.5e1', resolver()).expression.constant, -15);
});

test('parser: rejects nonlinear and malformed input with positions', () => {
  assert.throws(() => parseConstraint('a * b == 1', resolver()), /nonlinear/);
  assert.throws(() => parseConstraint('a / b == 1', resolver()), /division by a variable/);
  assert.throws(() => parseConstraint('a + == 1', resolver()), ParseError);
  assert.throws(() => parseConstraint('a == 1 )', resolver()), /trailing/);
  assert.throws(() => parseConstraint('a 1', resolver()), /expected ==/);
  assert.throws(() => parseConstraint('a == 1 @loud', resolver()), /unknown strength/);
  assert.throws(() => parseConstraint('a == $', resolver()), /unexpected character at column 6/);
  assert.throws(() => parseConstraint('a / 0 == 1', resolver()), /division by zero/);
});

test('boxes derive right, bottom and centres', () => {
  const L = new Layout();
  L.run(`
    box card
    card.left == 10
    card.top == 20
    card.width == 300
    card.height == 100
  `);
  assert.equal(L.value('card.right'), 310);
  assert.equal(L.value('card.bottom'), 120);
  assert.equal(L.value('card.centerX'), 160);
  assert.equal(L.value('card.centerY'), 70);
});

test('two column layout adapts to window width', () => {
  const L = new Layout();
  L.run(`
    box win side main
    win.left == 0
    win.top == 0
    win.height == 600
    edit win.width @strong
    side.left == win.left + 16
    main.left == side.right + 16
    main.right == win.right - 16
    side.top == 16
    main.top == 16
    side.bottom == win.bottom - 16
    main.bottom == side.bottom
    side.width == 240 @medium
    side.width >= 120
    main.width >= 2 * side.width
  `);
  L.suggest('win.width', 1200).solve();
  assert.deepEqual(L.rect('side'), { left: 16, top: 16, width: 240, height: 568 });
  assert.equal(L.rect('main').width, 1200 - 16 * 3 - 240);
  // Narrow: the required 2:1 rule squeezes the medium preferred width.
  L.suggest('win.width', 420);
  const side = L.rect('side').width;
  const main = L.rect('main').width;
  assert.ok(Math.abs(main - 2 * side) < 1e-6);
  assert.ok(Math.abs(side + main + 48 - 420) < 1e-6);
  assert.equal(L.violations().length, 1);
  // Narrower than the required minimum: the window edit itself gives way.
  L.suggest('win.width', 200);
  assert.equal(L.rect('side').width, 120);
  assert.equal(L.value('win.width'), 16 * 3 + 120 + 240);
});

test('constraints can be removed by id', () => {
  const L = new Layout();
  L.box('a');
  L.add('a.width == 50 @weak');
  L.add('a.width == 80 @strong', 'wide');
  assert.equal(L.value('a.width'), 80);
  L.remove('wide');
  assert.equal(L.value('a.width'), 50);
  assert.throws(() => L.remove('wide'), /no constraint/);
});

test('tryAdd reports unsatisfiable constraints without throwing', () => {
  const L = new Layout();
  L.box('a');
  L.add('a.width <= 100');
  const r = L.tryAdd('a.width >= 200');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /unsatisfiable/);
  assert.equal(L.tryAdd('a.width >= 50').ok, true);
  assert.equal(L.value('a.width'), 50);
});

test('script errors carry line numbers; strict mode catches typos', () => {
  const L = new Layout();
  assert.throws(() => L.run('box a\n\na.width == == 3'), (e) => e.line === 3);
  const S = new Layout();
  S.strict = true;
  S.box('panel');
  assert.throws(() => S.add('panle.width == 3'), /unknown variable "panle.width"/);
});

test('example scripts solve without violating required constraints', () => {
  for (const f of ['dashboard.cass', 'holy_grail.cass']) {
    const L = new Layout();
    L.run(readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
    for (const c of L.solver.constraints) {
      if (c.strength === Strength.required) assert.ok(c.violation() < 1e-6, `${f}: ${c}`);
    }
    for (const r of Object.values(L.rects())) assert.ok(r.width >= 0 && r.height >= 0);
  }
});
