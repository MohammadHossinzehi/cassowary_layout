// A tiny recursive descent parser for constraint text such as
//
//   sidebar.right + 12 == content.left            @required
//   content.width >= 2 * sidebar.width            @strong
//   (header.height + footer.height) / 2 <= 80     @medium*3
//
// Grammar:
//   constraint := expr op expr [ '@' strength ]
//   op         := '==' | '=' | '<=' | '>='
//   expr       := term (('+' | '-') term)*
//   term       := unary (('*' | '/') unary)*
//   unary      := '-' unary | primary
//   primary    := number | identifier | '(' expr ')'
// Products of two variable terms are rejected: the solver is linear.

import { Constraint, Expression } from './expression.js';
import { Strength } from './strength.js';

export class ParseError extends SyntaxError {
  constructor(message, source, pos) {
    super(`${message} at column ${pos + 1}: ${source}`);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

const TOKEN = /\s*(?:(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_][\w.]*)|(==|<=|>=|=|[-+*/()@]))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new ParseError('unexpected character', src, pos + (src.slice(pos).length - src.slice(pos).trimStart().length));
    const start = m.index + m[0].length - (m[1] ?? m[2] ?? m[3]).length;
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number(m[1]), pos: start });
    else if (m[2] !== undefined) tokens.push({ kind: 'id', value: m[2], pos: start });
    else tokens.push({ kind: 'op', value: m[3], pos: start });
    pos = TOKEN.lastIndex;
  }
  tokens.push({ kind: 'end', value: null, pos: src.length });
  return tokens;
}

/**
 * @param {string} src
 * @param {(name: string) => import('./expression.js').Variable} resolve
 */
export function parseConstraint(src, resolve) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const fail = (msg, t = peek()) => { throw new ParseError(msg, src, t.pos); };
  const isOp = (v) => peek().kind === 'op' && peek().value === v;

  function primary() {
    const t = next();
    if (t.kind === 'num') return Expression.from(t.value);
    if (t.kind === 'id') return Expression.from(resolve(t.value));
    if (t.kind === 'op' && t.value === '(') {
      const e = expr();
      if (!isOp(')')) fail('expected ")"');
      next();
      return e;
    }
    return fail('expected a number, variable or "("', t);
  }
  function unary() {
    if (isOp('-')) { next(); return unary().times(-1); }
    if (isOp('+')) { next(); return unary(); }
    return primary();
  }
  function term() {
    let e = unary();
    while (isOp('*') || isOp('/')) {
      const op = next();
      const rhs = unary();
      try {
        e = op.value === '*' ? e.times(rhs) : e.divide(rhs);
      } catch (err) {
        fail(err.message, op);
      }
    }
    return e;
  }
  function expr() {
    let e = term();
    while (isOp('+') || isOp('-')) {
      const op = next().value;
      const rhs = term();
      e = op === '+' ? e.plus(rhs) : e.minus(rhs);
    }
    return e;
  }

  const lhs = expr();
  const opTok = next();
  if (opTok.kind !== 'op' || !['==', '=', '<=', '>='].includes(opTok.value)) fail('expected ==, <= or >=', opTok);
  const rhs = expr();
  let strength = Strength.required;
  if (isOp('@')) {
    next();
    let spec = '';
    while (peek().kind !== 'end') spec += next().value;
    try { strength = Strength.parse(spec); } catch (err) { fail(err.message); }
  }
  if (peek().kind !== 'end') fail('unexpected trailing input');
  const op = opTok.value === '=' ? '==' : opTok.value;
  return new Constraint(lhs, op, rhs, strength, src.replace(/\s*@.*$/, '').trim());
}
