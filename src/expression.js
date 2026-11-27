// Variables, linear expressions and constraints: the user facing model.
//
// An Expression is an immutable map Variable -> coefficient plus a
// constant. A Constraint normalises `lhs op rhs` into `expr op 0` where
// expr = lhs - rhs, which is the only form the solver ever sees.

import { Strength } from './strength.js';

let nextVarId = 0;

export class Variable {
  constructor(name = `v${nextVarId}`) {
    this.id = nextVarId++;
    this.name = name;
    this.value = 0;
  }
  plus(x) { return Expression.from(this).plus(x); }
  minus(x) { return Expression.from(this).minus(x); }
  times(k) { return Expression.from(this).times(k); }
  divide(k) { return Expression.from(this).divide(k); }
  toString() { return this.name; }
}

export class Expression {
  /** @param {Map<Variable, number>} terms */
  constructor(terms = new Map(), constant = 0) {
    this.terms = terms;
    this.constant = constant;
  }

  static from(x) {
    if (x instanceof Expression) return x;
    if (x instanceof Variable) return new Expression(new Map([[x, 1]]), 0);
    if (typeof x === 'number' && Number.isFinite(x)) return new Expression(new Map(), x);
    throw new TypeError(`cannot convert ${x} to an expression`);
  }

  isConstant() { return this.terms.size === 0; }

  plus(x) {
    const o = Expression.from(x);
    const terms = new Map(this.terms);
    for (const [v, c] of o.terms) {
      const s = (terms.get(v) ?? 0) + c;
      if (s === 0) terms.delete(v); else terms.set(v, s);
    }
    return new Expression(terms, this.constant + o.constant);
  }

  minus(x) { return this.plus(Expression.from(x).times(-1)); }

  times(k) {
    if (k instanceof Expression || k instanceof Variable) {
      const o = Expression.from(k);
      if (o.isConstant()) return this.times(o.constant);
      if (this.isConstant()) return o.times(this.constant);
      throw new TypeError('nonlinear expression: product of two variable terms');
    }
    if (k === 0) return new Expression(new Map(), 0);
    const terms = new Map();
    for (const [v, c] of this.terms) terms.set(v, c * k);
    return new Expression(terms, this.constant * k);
  }

  divide(k) {
    if (k instanceof Expression || k instanceof Variable) {
      const o = Expression.from(k);
      if (!o.isConstant()) throw new TypeError('nonlinear expression: division by a variable');
      k = o.constant;
    }
    if (k === 0) throw new RangeError('division by zero');
    return this.times(1 / k);
  }

  value() {
    let s = this.constant;
    for (const [v, c] of this.terms) s += c * v.value;
    return s;
  }

  toString() {
    const parts = [];
    for (const [v, c] of this.terms) {
      const mag = Math.abs(c);
      const body = mag === 1 ? v.name : `${mag} * ${v.name}`;
      parts.push(parts.length === 0 ? (c < 0 ? `-${body}` : body) : (c < 0 ? ` - ${body}` : ` + ${body}`));
    }
    if (this.constant !== 0 || parts.length === 0) {
      const mag = Math.abs(this.constant);
      parts.push(parts.length === 0 ? String(this.constant) : (this.constant < 0 ? ` - ${mag}` : ` + ${mag}`));
    }
    return parts.join('');
  }
}

export const Operator = Object.freeze({ LE: '<=', GE: '>=', EQ: '==' });

export class Constraint {
  /**
   * @param {Expression|Variable|number} lhs
   * @param {'<='|'>='|'=='} op
   * @param {Expression|Variable|number} rhs
   * @param {number|string} strength
   */
  constructor(lhs, op, rhs = 0, strength = Strength.required, source = null) {
    if (op !== '<=' && op !== '>=' && op !== '==') throw new TypeError(`bad operator ${op}`);
    this.expression = Expression.from(lhs).minus(rhs);
    this.op = op;
    this.strength = Strength.parse(strength);
    this.source = source;
    this.suggested = 0;
  }

  /** How far the current variable values are from satisfying this constraint. */
  violation() {
    // Edit constraints keep their target outside the expression (the solver
    // moves it by editing row constants), so account for it here.
    const e = this.expression.value() - this.suggested;
    if (this.op === '==') return Math.abs(e);
    if (this.op === '<=') return Math.max(0, e);
    return Math.max(0, -e);
  }

  toString() {
    const s = this.source ?? `${this.expression} ${this.op} 0`;
    return `${s} @${Strength.name(this.strength)}`;
  }
}

// Small fluent helpers so code reads like the math.
export const eq = (a, b, s) => new Constraint(a, '==', b, s);
export const le = (a, b, s) => new Constraint(a, '<=', b, s);
export const ge = (a, b, s) => new Constraint(a, '>=', b, s);
