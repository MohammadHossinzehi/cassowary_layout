// A small layout layer on top of the solver: named variables, boxes with
// derived edges, constraint text, edit variables, and a script format
// used by the CLI and the browser demo.
//
// Script format (one statement per line, "#" starts a comment):
//
//   box  header sidebar content          # declares left/top/width/height/right/bottom/centerX/centerY
//   var  gutter                          # a free scalar variable
//   header.left == 0
//   sidebar.width >= 180 @strong
//   edit window.width @strong            # make window.width suggestible
//   suggest window.width = 1280          # edit (strong) and suggest in one go

import { Constraint, Expression, Variable } from './expression.js';
import { parseConstraint } from './parse.js';
import { Solver } from './solver.js';
import { Strength } from './strength.js';

export const BOX_FIELDS = ['left', 'top', 'width', 'height', 'right', 'bottom', 'centerX', 'centerY'];

export class Layout {
  constructor() {
    this.solver = new Solver();
    /** @type {Map<string, Variable>} */
    this.vars = new Map();
    /** @type {Map<string, Record<string, Variable>>} */
    this.boxes = new Map();
    /** @type {Map<string, Constraint>} */
    this.byId = new Map();
    this.strict = false;
  }

  variable(name) {
    let v = this.vars.get(name);
    if (!v) {
      if (this.strict) throw new ReferenceError(`unknown variable "${name}" (declare it with box or var)`);
      v = new Variable(name);
      this.vars.set(name, v);
    }
    return v;
  }

  /** Declare a rectangle. Edges and centres are tied to left/top/width/height. */
  box(name) {
    if (this.boxes.has(name)) return this.boxes.get(name);
    const b = {};
    for (const f of BOX_FIELDS) {
      b[f] = new Variable(`${name}.${f}`);
      this.vars.set(`${name}.${f}`, b[f]);
    }
    const s = this.solver;
    s.addConstraint(new Constraint(b.right, '==', b.left.plus(b.width), 'required', `${name}.right == ${name}.left + ${name}.width`));
    s.addConstraint(new Constraint(b.bottom, '==', b.top.plus(b.height), 'required', `${name}.bottom == ${name}.top + ${name}.height`));
    s.addConstraint(new Constraint(b.centerX, '==', b.left.plus(b.width.divide(2)), 'required', `${name}.centerX == ${name}.left + ${name}.width / 2`));
    s.addConstraint(new Constraint(b.centerY, '==', b.top.plus(b.height.divide(2)), 'required', `${name}.centerY == ${name}.top + ${name}.height / 2`));
    s.addConstraint(new Constraint(b.width, '>=', 0, 'required', `${name}.width >= 0`));
    s.addConstraint(new Constraint(b.height, '>=', 0, 'required', `${name}.height >= 0`));
    this.boxes.set(name, b);
    return b;
  }

  /** Parse and add a constraint; returns it so it can be removed later. */
  add(text, id = null) {
    const c = typeof text === 'string' ? parseConstraint(text, (n) => this.variable(n)) : text;
    this.solver.addConstraint(c);
    if (id) this.byId.set(id, c);
    return c;
  }

  /** Try to add; on an unsatisfiable required constraint return the error instead of throwing. */
  tryAdd(text, id = null) {
    try { return { ok: true, constraint: this.add(text, id) }; } catch (error) { return { ok: false, error }; }
  }

  remove(constraintOrId) {
    const c = typeof constraintOrId === 'string' ? this.byId.get(constraintOrId) : constraintOrId;
    if (!c) throw new ReferenceError(`no constraint with id "${constraintOrId}"`);
    this.solver.removeConstraint(c);
    for (const [k, v] of this.byId) if (v === c) this.byId.delete(k);
  }

  edit(name, strength = Strength.strong) {
    const v = this.variable(name);
    if (!this.solver.hasEditVariable(v)) this.solver.addEditVariable(v, strength);
    return v;
  }

  suggest(name, value) {
    const v = this.edit(name);
    this.solver.suggestValue(v, value);
    return this;
  }

  solve() {
    this.solver.updateVariables();
    return this;
  }

  value(name) {
    this.solver.updateVariables();
    const v = this.vars.get(name);
    if (!v) throw new ReferenceError(`unknown variable "${name}"`);
    return v.value;
  }

  values() {
    this.solver.updateVariables();
    const out = {};
    for (const [k, v] of this.vars) out[k] = round(v.value);
    return out;
  }

  rect(name) {
    this.solver.updateVariables();
    const b = this.boxes.get(name);
    if (!b) throw new ReferenceError(`unknown box "${name}"`);
    return { left: round(b.left.value), top: round(b.top.value), width: round(b.width.value), height: round(b.height.value) };
  }

  rects() {
    const out = {};
    for (const name of this.boxes.keys()) out[name] = this.rect(name);
    return out;
  }

  /** Non required constraints that are currently not fully satisfied. */
  violations(tolerance = 1e-6) {
    this.solver.updateVariables();
    return this.solver.constraints
      .filter((c) => c.strength < Strength.required && c.violation() > tolerance)
      .map((c) => ({ constraint: c.toString(), amount: round(c.violation()) }));
  }

  /** Run a script (see file header). Errors carry the 1 based line number. */
  run(script) {
    const lines = script.split(/\r?\n/);
    lines.forEach((raw, idx) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      try {
        this._statement(line);
      } catch (err) {
        err.message = `line ${idx + 1}: ${err.message}`;
        err.line = idx + 1;
        throw err;
      }
    });
    return this.solve();
  }

  _statement(line) {
    let m;
    if ((m = /^box\s+(.+)$/.exec(line))) { for (const n of m[1].split(/[\s,]+/)) this.box(n); return; }
    if ((m = /^var\s+(.+)$/.exec(line))) { for (const n of m[1].split(/[\s,]+/)) this.variable(n); return; }
    if ((m = /^edit\s+([A-Za-z_][\w.]*)\s*(?:@\s*(.+))?$/.exec(line))) { this.edit(m[1], m[2] ?? 'strong'); return; }
    if ((m = /^suggest\s+([A-Za-z_][\w.]*)\s*=\s*(\S+)$/.exec(line))) {
      const value = Number(m[2]);
      if (!Number.isFinite(value)) throw new SyntaxError(`bad number "${m[2]}"`);
      this.suggest(m[1], value);
      return;
    }
    this.add(line);
  }
}

function round(x) {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

export { Expression };
