// The Cassowary incremental simplex solver.
//
// Follows Badros, Borning and Stuckey, "The Cassowary Linear Arithmetic
// Constraint Solving Algorithm" (TOCHI 2001), in the refined formulation
// used by the Kiwi solver:
//
//  * Every constraint becomes one tableau row with a "marker" symbol that
//    lets us find and remove it later without rebuilding anything.
//  * Non required constraints get error symbols that are penalised in the
//    objective with their strength, so the primal simplex minimises the
//    lexicographically weighted violation.
//  * Edit variables are weak/medium/strong equalities whose constant we
//    move directly; that keeps the tableau optimal but may make it primal
//    infeasible, which the dual simplex repairs in a handful of pivots.
//
// Two additions over Kiwi: pivoting uses Bland's rule (lowest symbol id
// enters, ties in the ratio test go to the lowest id) so degenerate
// layouts can never cycle, and a failed required add is transactional:
// the tableau is restored exactly instead of being left half modified.

import { Constraint, Expression, Variable } from './expression.js';
import { Strength } from './strength.js';

const EPS = 1e-8;
const nearZero = (x) => (x < 0 ? -x < EPS : x < EPS);

export const SymbolType = Object.freeze({ Invalid: 0, External: 1, Slack: 2, Error: 3, Dummy: 4 });

class Sym {
  constructor(id, type) { this.id = id; this.type = type; }
}
const INVALID = new Sym(-1, SymbolType.Invalid);

export class SolverError extends Error {
  constructor(message, constraint = null) {
    super(message);
    this.name = new.target.name;
    this.constraint = constraint;
  }
}
export class UnsatisfiableConstraintError extends SolverError {}
export class DuplicateConstraintError extends SolverError {}
export class UnknownConstraintError extends SolverError {}
export class DuplicateEditVariableError extends SolverError {}
export class UnknownEditVariableError extends SolverError {}
export class BadRequiredStrengthError extends SolverError {}
export class InternalSolverError extends SolverError {}

/** A tableau row: basic = constant + sum(coefficient * symbol). */
class Row {
  constructor(constant = 0) {
    this.constant = constant;
    /** @type {Map<Sym, number>} */
    this.cells = new Map();
  }
  copy() {
    const r = new Row(this.constant);
    r.cells = new Map(this.cells);
    return r;
  }
  add(value) { return (this.constant += value); }
  insertSymbol(sym, coeff = 1) {
    const c = (this.cells.get(sym) ?? 0) + coeff;
    if (nearZero(c)) this.cells.delete(sym); else this.cells.set(sym, c);
  }
  insertRow(other, coeff = 1) {
    this.constant += other.constant * coeff;
    for (const [s, c] of other.cells) this.insertSymbol(s, c * coeff);
  }
  remove(sym) { this.cells.delete(sym); }
  reverseSign() {
    this.constant = -this.constant;
    for (const [s, c] of this.cells) this.cells.set(s, -c);
  }
  /** Treat the row as 0 = this, and solve it for sym. */
  solveFor(sym) {
    const coeff = -1 / this.cells.get(sym);
    this.cells.delete(sym);
    this.constant *= coeff;
    for (const [s, c] of this.cells) this.cells.set(s, c * coeff);
  }
  /** Row currently reads lhs = this; re-solve it for rhs. */
  solveForPair(lhs, rhs) {
    this.insertSymbol(lhs, -1);
    this.solveFor(rhs);
  }
  coefficientFor(sym) { return this.cells.get(sym) ?? 0; }
  substitute(sym, row) {
    const c = this.cells.get(sym);
    if (c !== undefined) {
      this.cells.delete(sym);
      this.insertRow(row, c);
    }
  }
}

export class Solver {
  constructor() {
    this._nextSymId = 0;
    /** @type {Map<Constraint, {marker: Sym, other: Sym}>} */
    this._cns = new Map();
    /** @type {Map<Sym, Row>} */
    this._rows = new Map();
    /** @type {Map<Variable, Sym>} */
    this._vars = new Map();
    /** @type {Map<Variable, {tag, constraint: Constraint, constant: number}>} */
    this._edits = new Map();
    this._infeasible = [];
    this._objective = new Row();
    this._artificial = null;
    this.stats = { pivots: 0, dualPivots: 0 };
  }

  // ------------------------------------------------------------ public API

  addConstraint(constraint) {
    if (!(constraint instanceof Constraint)) throw new TypeError('addConstraint expects a Constraint');
    if (this._cns.has(constraint)) throw new DuplicateConstraintError('constraint already added', constraint);

    const tag = { marker: INVALID, other: INVALID };
    const row = this._createRow(constraint, tag);
    let subject = this._chooseSubject(row, tag);

    if (subject.type === SymbolType.Invalid && this._allDummies(row)) {
      if (!nearZero(row.constant)) {
        throw new UnsatisfiableConstraintError(`unsatisfiable constraint: ${constraint}`, constraint);
      }
      subject = tag.marker;
    }

    if (subject.type === SymbolType.Invalid) {
      const snapshot = this._snapshot();
      if (!this._addWithArtificialVariable(row)) {
        this._restore(snapshot);
        throw new UnsatisfiableConstraintError(`unsatisfiable constraint: ${constraint}`, constraint);
      }
    } else {
      row.solveFor(subject);
      this._substitute(subject, row);
      this._rows.set(subject, row);
    }

    this._cns.set(constraint, tag);
    this._optimize(this._objective);
    return constraint;
  }

  removeConstraint(constraint) {
    const tag = this._cns.get(constraint);
    if (!tag) throw new UnknownConstraintError('unknown constraint', constraint);
    this._cns.delete(constraint);

    // Take the error symbols out of the objective first.
    if (tag.marker.type === SymbolType.Error) this._removeMarkerEffects(tag.marker, constraint.strength);
    if (tag.other.type === SymbolType.Error) this._removeMarkerEffects(tag.other, constraint.strength);

    if (this._rows.has(tag.marker)) {
      this._rows.delete(tag.marker);
    } else {
      const leaving = this._getMarkerLeavingSymbol(tag.marker);
      if (leaving.type === SymbolType.Invalid) throw new InternalSolverError('failed to find leaving row');
      const row = this._rows.get(leaving);
      this._rows.delete(leaving);
      row.solveForPair(leaving, tag.marker);
      this._substitute(tag.marker, row);
    }
    this._optimize(this._objective);
  }

  hasConstraint(constraint) { return this._cns.has(constraint); }

  addEditVariable(variable, strength = Strength.strong) {
    if (this._edits.has(variable)) throw new DuplicateEditVariableError(`${variable} is already an edit variable`);
    strength = Strength.parse(strength);
    if (strength === Strength.required) throw new BadRequiredStrengthError('edit variables cannot be required');
    const constraint = new Constraint(variable, '==', 0, strength, `edit(${variable.name})`);
    this.addConstraint(constraint);
    this._edits.set(variable, { tag: this._cns.get(constraint), constraint, constant: 0 });
  }

  removeEditVariable(variable) {
    const info = this._edits.get(variable);
    if (!info) throw new UnknownEditVariableError(`${variable} is not an edit variable`);
    this.removeConstraint(info.constraint);
    this._edits.delete(variable);
  }

  hasEditVariable(variable) { return this._edits.has(variable); }

  suggestValue(variable, value) {
    const info = this._edits.get(variable);
    if (!info) throw new UnknownEditVariableError(`${variable} is not an edit variable`);
    const delta = value - info.constant;
    info.constant = value;
    info.constraint.suggested = value;
    const { marker, other } = info.tag;

    let row = this._rows.get(marker);
    if (row) {
      if (row.add(-delta) < 0) this._infeasible.push(marker);
      this._dualOptimize();
      return;
    }
    row = this._rows.get(other);
    if (row) {
      if (row.add(delta) < 0) this._infeasible.push(other);
      this._dualOptimize();
      return;
    }
    for (const [sym, r] of this._rows) {
      const c = r.coefficientFor(marker);
      if (c !== 0 && r.add(delta * c) < 0 && sym.type !== SymbolType.External) this._infeasible.push(sym);
    }
    this._dualOptimize();
  }

  /** Copy the solved values into each Variable's `.value`. */
  updateVariables() {
    for (const [v, sym] of this._vars) {
      const row = this._rows.get(sym);
      const x = row ? row.constant : 0;
      v.value = nearZero(x) ? 0 : x;
    }
  }

  /** Current weighted violation of all non required constraints. */
  objectiveValue() { return this._objective.constant; }

  get constraintCount() { return this._cns.size; }
  get constraints() { return [...this._cns.keys()]; }

  reset() {
    this._cns.clear();
    this._rows.clear();
    this._vars.clear();
    this._edits.clear();
    this._infeasible = [];
    this._objective = new Row();
    this._artificial = null;
  }

  // ------------------------------------------------------------ internals

  _sym(type) { return new Sym(this._nextSymId++, type); }

  _varSymbol(v) {
    let s = this._vars.get(v);
    if (!s) { s = this._sym(SymbolType.External); this._vars.set(v, s); }
    return s;
  }

  _createRow(constraint, tag) {
    const expr = constraint.expression;
    const row = new Row(expr.constant);
    for (const [v, c] of expr.terms) {
      if (nearZero(c)) continue;
      const sym = this._varSymbol(v);
      const basic = this._rows.get(sym);
      if (basic) row.insertRow(basic, c); else row.insertSymbol(sym, c);
    }

    const strength = constraint.strength;
    if (constraint.op === '<=' || constraint.op === '>=') {
      const coeff = constraint.op === '<=' ? 1 : -1;
      const slack = this._sym(SymbolType.Slack);
      tag.marker = slack;
      row.insertSymbol(slack, coeff);
      if (strength < Strength.required) {
        const error = this._sym(SymbolType.Error);
        tag.other = error;
        row.insertSymbol(error, -coeff);
        this._objective.insertSymbol(error, strength);
      }
    } else if (strength < Strength.required) {
      const plus = this._sym(SymbolType.Error);
      const minus = this._sym(SymbolType.Error);
      tag.marker = plus;
      tag.other = minus;
      row.insertSymbol(plus, -1);
      row.insertSymbol(minus, 1);
      this._objective.insertSymbol(plus, strength);
      this._objective.insertSymbol(minus, strength);
    } else {
      const dummy = this._sym(SymbolType.Dummy);
      tag.marker = dummy;
      row.insertSymbol(dummy);
    }

    if (row.constant < 0) row.reverseSign();
    return row;
  }

  _chooseSubject(row, tag) {
    for (const s of row.cells.keys()) if (s.type === SymbolType.External) return s;
    const pivotable = (s) => s.type === SymbolType.Slack || s.type === SymbolType.Error;
    if (pivotable(tag.marker) && row.coefficientFor(tag.marker) < 0) return tag.marker;
    if (pivotable(tag.other) && row.coefficientFor(tag.other) < 0) return tag.other;
    return INVALID;
  }

  _allDummies(row) {
    for (const s of row.cells.keys()) if (s.type !== SymbolType.Dummy) return false;
    return true;
  }

  _addWithArtificialVariable(row) {
    const art = this._sym(SymbolType.Slack);
    this._rows.set(art, row.copy());
    this._artificial = row.copy();
    this._optimize(this._artificial);
    const success = nearZero(this._artificial.constant);
    this._artificial = null;

    const basic = this._rows.get(art);
    if (basic) {
      this._rows.delete(art);
      if (basic.cells.size === 0) return success;
      const entering = this._anyPivotableSymbol(basic);
      if (entering.type === SymbolType.Invalid) return false;
      basic.solveForPair(art, entering);
      this._substitute(entering, basic);
      this._rows.set(entering, basic);
    }
    for (const r of this._rows.values()) r.remove(art);
    this._objective.remove(art);
    return success;
  }

  _anyPivotableSymbol(row) {
    let best = INVALID;
    for (const s of row.cells.keys()) {
      if ((s.type === SymbolType.Slack || s.type === SymbolType.Error) && (best === INVALID || s.id < best.id)) best = s;
    }
    return best;
  }

  _substitute(sym, row) {
    for (const [s, r] of this._rows) {
      r.substitute(sym, row);
      if (s.type !== SymbolType.External && r.constant < 0) this._infeasible.push(s);
    }
    this._objective.substitute(sym, row);
    if (this._artificial) this._artificial.substitute(sym, row);
  }

  _pivot(leaving, entering) {
    const row = this._rows.get(leaving);
    this._rows.delete(leaving);
    row.solveForPair(leaving, entering);
    this._substitute(entering, row);
    this._rows.set(entering, row);
  }

  /** Primal simplex on the given objective row (Bland's rule). */
  _optimize(objective) {
    for (;;) {
      let entering = INVALID;
      for (const [s, c] of objective.cells) {
        if (s.type !== SymbolType.Dummy && c < 0 && (entering === INVALID || s.id < entering.id)) entering = s;
      }
      if (entering === INVALID) return;

      let leaving = INVALID;
      let best = Infinity;
      for (const [s, r] of this._rows) {
        if (s.type === SymbolType.External) continue;
        const c = r.coefficientFor(entering);
        if (c < 0) {
          const ratio = -r.constant / c;
          if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && s.id < leaving.id)) {
            best = ratio;
            leaving = s;
          }
        }
      }
      if (leaving === INVALID) throw new InternalSolverError('objective is unbounded');
      this.stats.pivots++;
      this._pivot(leaving, entering);
    }
  }

  /** Dual simplex: restore feasibility after edit suggestions. */
  _dualOptimize() {
    while (this._infeasible.length) {
      const leaving = this._infeasible.pop();
      const row = this._rows.get(leaving);
      if (!row || nearZero(row.constant) || row.constant >= 0) continue;
      let entering = INVALID;
      let best = Infinity;
      for (const [s, c] of row.cells) {
        if (c > 0 && s.type !== SymbolType.Dummy) {
          const ratio = this._objective.coefficientFor(s) / c;
          if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && s.id < entering.id)) {
            best = ratio;
            entering = s;
          }
        }
      }
      if (entering === INVALID) throw new InternalSolverError('dual optimize failed');
      this.stats.dualPivots++;
      this._pivot(leaving, entering);
    }
  }

  _getMarkerLeavingSymbol(marker) {
    let r1 = Infinity, r2 = Infinity;
    let first = INVALID, second = INVALID, third = INVALID;
    for (const [s, row] of this._rows) {
      const c = row.coefficientFor(marker);
      if (c === 0) continue;
      if (s.type === SymbolType.External) {
        third = s;
      } else if (c < 0) {
        const r = -row.constant / c;
        if (r < r1) { r1 = r; first = s; }
      } else {
        const r = row.constant / c;
        if (r < r2) { r2 = r; second = s; }
      }
    }
    if (first !== INVALID) return first;
    if (second !== INVALID) return second;
    return third;
  }

  _removeMarkerEffects(marker, strength) {
    const row = this._rows.get(marker);
    if (row) this._objective.insertRow(row, -strength);
    else this._objective.insertSymbol(marker, -strength);
  }

  _snapshot() {
    const rows = new Map();
    for (const [s, r] of this._rows) rows.set(s, r.copy());
    return { rows, objective: this._objective.copy(), infeasible: [...this._infeasible] };
  }

  _restore(snap) {
    this._rows = snap.rows;
    this._objective = snap.objective;
    this._infeasible = snap.infeasible;
    this._artificial = null;
  }
}

export { Constraint, Expression, Variable };
