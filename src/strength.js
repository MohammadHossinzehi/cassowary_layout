// Constraint strengths.
//
// Cassowary orders constraints lexicographically: no amount of weak
// violation may ever buy a single unit of medium violation, and so on.
// Like the Kiwi solver, we encode the hierarchy as one scalar per level
// with a base of 1000 and clamp each component to [0, 1000]. That keeps
// the arithmetic in plain doubles while staying lexicographic for any
// realistic layout (thousands of constraints per level).

export function createStrength(a, b, c, w = 1) {
  let result = 0;
  result += Math.max(0, Math.min(1000, a * w)) * 1e6;
  result += Math.max(0, Math.min(1000, b * w)) * 1e3;
  result += Math.max(0, Math.min(1000, c * w));
  return result;
}

export const Strength = Object.freeze({
  required: createStrength(1000, 1000, 1000),
  strong: createStrength(1, 0, 0),
  medium: createStrength(0, 1, 0),
  weak: createStrength(0, 0, 1),
  create: createStrength,
  clip(value) {
    return Math.max(0, Math.min(Strength.required, value));
  },
  /** Accepts a number or one of the names above (optionally "strong*2"). */
  parse(spec) {
    if (typeof spec === 'number') return Strength.clip(spec);
    if (spec === undefined || spec === null) return Strength.required;
    const m = /^\s*(required|strong|medium|weak|\d+(?:\.\d+)?)\s*(?:\*\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(spec));
    if (!m) throw new TypeError(`unknown strength "${spec}"`);
    const base = m[1] in Strength ? Strength[m[1]] : Number(m[1]);
    const weight = m[2] === undefined ? 1 : Number(m[2]);
    if (m[1] === 'required') return Strength.required;
    return Strength.clip(base * weight);
  },
  name(value) {
    for (const k of ['required', 'strong', 'medium', 'weak']) if (Strength[k] === value) return k;
    return String(value);
  },
});
