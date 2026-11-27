# cassowary_layout

An incremental linear constraint solver for user interface layout, written from scratch in plain JavaScript with zero dependencies. It implements the Cassowary algorithm (the one behind Apple's Auto Layout, GSS and Kiwi), plus a small layout language, a command line tool, a browser playground and a test suite that checks every answer against an independent brute force oracle.

## The problem

Layout rules are rarely all satisfiable at once. "The sidebar should be 240px", "the content should be at least twice as wide as the sidebar" and "everything must fit in the window" will fight each other as soon as the window gets narrow. You want two things from a solver:

1. **Priorities.** Some rules are hard (`required`), others are preferences (`strong`, `medium`, `weak`). A weaker rule must never win against a stronger one, no matter how many weak rules gang up.
2. **Speed while things move.** When the user drags a window edge you need a new answer every frame. Rebuilding and re solving the whole system 60 times a second is wasteful when only one number changed.

Cassowary solves both: it keeps a simplex tableau that stays optimal as you add and remove constraints, and it handles the "one number changed" case with a few dual simplex pivots instead of starting over.

```
$ node bin/cassowary.js solve examples/holy_grail.cass
box         left       top     width    height
page           0         0      1024       768
header        12        12      1000        64
nav           12        88       200       608
main         224        88       576       608
aside        812        88       200       608
footer        12       708      1000        48
```

Shrink the page and watch which preferences give way:

```
$ node bin/cassowary.js solve examples/dashboard.cass win.width=500
...
relaxed (non required constraints not fully met):
  edit(win.width) @strong  off by 22.666667
  sidebar.width == 220 @strong  off by 89.333333
  c.bottom == win.bottom - 24 @weak  off by 492
```

The cards have a required minimum width, so at 500px the solver widens the window a little (an edit is only `strong`) and squeezes the sidebar. Together those cost the least strong violation, and every required rule still holds.

## Running it

Requires Node 18 or newer. Nothing to install.

```
npm test                                                   # 25 tests, thousands of them oracle checked
npm run bench                                              # incremental resize vs rebuild per frame
node bin/cassowary.js solve examples/holy_grail.cass       # solve a layout script
node bin/cassowary.js solve examples/dashboard.cass win.width=900 format=json
node bin/cassowary.js sweep examples/holy_grail.cass page.width 300 1300 250
npm run demo                                               # playground at http://localhost:8080/demo/
```

The playground lets you edit a layout script on the left and drag the window corner on the right; every pointer move calls `suggestValue` and redraws the boxes along with which soft constraints are currently relaxed.

## Using the library

```js
import { Solver, Variable, eq, ge, le } from './src/index.js';

const s = new Solver();
const left = new Variable('left');
const width = new Variable('width');

s.addConstraint(ge(width, 100));                       // required by default
s.addConstraint(eq(width, 300, 'weak'));               // a preference
s.addConstraint(le(left.plus(width), 800));            // fits in 800px
s.addEditVariable(left, 'strong');                     // the user drags this

s.suggestValue(left, 650);
s.updateVariables();
console.log(left.value, width.value);                  // 650 150
```

Or, at a higher level, with text constraints and boxes:

```js
import { Layout } from './src/index.js';

const L = new Layout();
L.run(`
  box win side main
  win.left == 0
  win.top == 0
  win.height == 600
  edit win.width @strong
  side.left == win.left + 16
  main.left == side.right + 16
  main.right + 16 == win.right
  side.width == 240 @medium
  main.width >= 2 * side.width
`);
L.suggest('win.width', 420);
L.rect('side');       // { left: 16, top: 0, width: 124, height: 0 }
L.violations();       // [{ constraint: 'side.width == 240 @medium', amount: 116 }]
```

A `box name` declares `left, top, width, height` plus derived `right, bottom, centerX, centerY` tied together by required equalities, and requires a non negative size. Constraint text supports `+ * /`, unary minus, parentheses, `==` (or `=`), `<=`, `>=`, and an optional `@strength` such as `@strong`, `@medium*3` or a raw number. Products of two variables are rejected with a column number, since the solver is linear. `Layout.strict = true` turns references to undeclared names into errors, which catches typos like `panle.width`.

## How it works

`src/solver.js` is the heart of the project (about 450 lines). It follows Badros, Borning and Stuckey's paper in the refined formulation popularised by the Kiwi solver:

* **Rows and markers.** Each constraint `expr op 0` becomes one tableau row. Inequalities get a slack symbol, soft constraints get error symbols, and required equalities get a dummy symbol. One of these is remembered as the constraint's *marker*, so it can later be pivoted back into the basis and its row dropped: removal is incremental too.
* **Strength as weights.** Error symbols enter the objective weighted by strength. Strengths are encoded as `strong = 1e6, medium = 1e3, weak = 1` with each level clamped to 1000, which keeps the ordering lexicographic for any realistic layout while staying in plain doubles. A test adds 500 weak constraints against one strong one to prove the strong one still wins.
* **Primal simplex** runs after every add or remove to restore optimality. When a new required row has no obvious basic variable it is entered through an artificial variable phase.
* **Edit variables** are soft equalities whose right hand side lives outside the tableau. `suggestValue` shifts row constants directly, which keeps the tableau optimal but possibly infeasible, and then a **dual simplex** loop pivots it back. In the benchmark (60 columns, 690 constraints) that is about 0.7 ms per frame against about 70 ms to rebuild, roughly 100x faster.

Two design decisions go beyond the reference implementations:

* **Bland's rule for pivoting.** Both the primal and the dual loop choose the lowest id symbol among the eligible ones and break ratio ties the same way. Layouts are full of degenerate structure (stacks of identical `a <= b`, `a == b @weak` pairs) and Bland's rule rules out cycling by construction rather than by luck. A dedicated test builds exactly that kind of stack.
* **Transactional failure.** When a required constraint turns out unsatisfiable during the artificial phase, the pivots have already rewritten the tableau. Instead of leaving the solver in a half modified state, the solver snapshots the rows before that phase and restores them on failure. The caller gets an `UnsatisfiableConstraintError` and a solver that behaves exactly as before. Removing the restore makes all four oracle suites fail, so this is not hypothetical.

## Testing

The interesting tests are differential, in `test/oracle.test.js`. `test/oracle.js` is a deliberately naive, independent solver: the Cassowary objective is a convex piecewise linear function, so its minimum over the required region is attained at a vertex of the arrangement of constraint boundaries. The oracle tries every n subset of boundaries, solves each n by n system with Gaussian elimination, discards points that break a required constraint, and keeps the cheapest. It shares no code with the tableau. Seeded random systems in 2 and 3 variables are then checked for:

* the same optimal weighted violation as the oracle after every add (400 systems);
* rejections only when the oracle agrees the required set is infeasible, with the solution unchanged afterwards;
* continued optimality after every removal in random order (250 systems);
* optimality after every `suggestValue` with one or two edit variables at mixed strengths (200 systems, 8 rounds each);
* incremental churn (remove half, re add) giving the same objective as a solver built from scratch.

I checked that the suite has teeth by mutating the solver: dropping the dual simplex trigger, skipping the reoptimisation after removal, or skipping the transactional restore each makes at least one suite fail. The unit tests in `test/solver.test.js` and `test/layout.test.js` cover the strength hierarchy, error types, redundant equalities, constant only constraints, drag simulations, the parser and the example scripts.

## Layout of the repository

```
src/strength.js     strength encoding and parsing
src/expression.js   Variable, Expression, Constraint
src/solver.js       the incremental simplex solver
src/parse.js        recursive descent parser for constraint text
src/layout.js       boxes, named variables, scripts, edit helpers
src/index.js        public exports
bin/cassowary.js    CLI: solve, sweep, serve
demo/index.html     interactive playground (served by npm run demo)
examples/*.cass     layout scripts
bench/bench.js      incremental vs rebuild benchmark
test/               node:test suites and the brute force oracle
```

## References

* Greg J. Badros, Alan Borning, Peter J. Stuckey. *The Cassowary Linear Arithmetic Constraint Solving Algorithm.* ACM TOCHI, 2001.
* The Kiwi solver by Chris Colbert, whose formulation of rows and markers this implementation follows.

MIT licensed.
