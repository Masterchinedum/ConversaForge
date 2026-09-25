/**
 * Guard for author-supplied regular expressions (runtime variable `pattern`, custom-function JSON
 * schema `pattern`). They are compiled with `new RegExp` and run against untrusted input on a shared
 * server, so a pattern with catastrophic backtracking is a denial-of-service vector for every tenant.
 *
 * `regexPatternRisk` is a conservative static check that rejects the classic exponential shapes:
 *   - a quantified group that itself contains a quantifier        (a+)+  (\w*x?)*  (a{1,5}){2,}
 *   - a quantified group containing alternation                     (a|ab)*  (x|y)+
 *   - backreferences / named backreferences                          (a)\1   \k<n>
 *   - more than MAX_UNBOUNDED unbounded quantifiers (polynomial blow-up like \d*\d*\d*\d*\d*x)
 * Servers should additionally run the test under a time budget (see setPatternTester).
 */
export const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_UNBOUNDED = 4;

interface Frame {
  quantifiedInside: boolean;
  alternation: boolean;
}

/** Returns a human-readable reason when the pattern is unsafe, otherwise null. */
export function regexPatternRisk(pattern: string): string | null {
  if (typeof pattern !== 'string') return 'Pattern must be a string';
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return `Pattern is too long (max ${MAX_REGEX_PATTERN_LENGTH} characters)`;
  const stack: Frame[] = [{ quantifiedInside: false, alternation: false }];
  let unbounded = 0;
  let inClass = false;
  // Whether the previous atom was a group that contained a quantifier / alternation.
  let lastGroup: Frame | null = null;

  const quantifierAt = (i: number): { len: number; repeats: boolean; unbounded: boolean } | null => {
    const c = pattern[i];
    if (c === '*' || c === '+') return { len: 1, repeats: true, unbounded: true };
    if (c === '?') return { len: 1, repeats: false, unbounded: false };
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return null;
      const min = Number(m[1]);
      const max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      return { len: m[0].length, repeats: max > 1, unbounded: max === Infinity || max > 1000 };
    }
    return null;
  };

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (!inClass && (/[1-9]/.test(n) || n === 'k')) return 'Backreferences are not allowed in patterns';
      i++;
      lastGroup = null;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      lastGroup = null;
      continue;
    }
    if (c === '(') {
      stack.push({ quantifiedInside: false, alternation: false });
      lastGroup = null;
      continue;
    }
    if (c === ')') {
      const frame = stack.length > 1 ? stack.pop()! : { quantifiedInside: false, alternation: false };
      lastGroup = frame;
      // A group containing a quantifier makes its parent "contain a quantifier" too.
      if (frame.quantifiedInside) stack[stack.length - 1]!.quantifiedInside = true;
      continue;
    }
    if (c === '|') {
      stack[stack.length - 1]!.alternation = true;
      lastGroup = null;
      continue;
    }
    const q = quantifierAt(i);
    if (q) {
      if (q.unbounded) unbounded++;
      if (q.repeats) {
        if (lastGroup && (lastGroup.quantifiedInside || lastGroup.alternation)) {
          return 'Pattern has a repeated group containing a quantifier or alternation (catastrophic backtracking risk)';
        }
        stack[stack.length - 1]!.quantifiedInside = true;
      }
      i += q.len - 1;
      // Lazy/possessive suffix.
      if (pattern[i + 1] === '?') i++;
      lastGroup = null;
      continue;
    }
    lastGroup = null;
  }
  if (unbounded > MAX_UNBOUNDED) return `Pattern has too many unbounded repetitions (max ${MAX_UNBOUNDED})`;
  return null;
}

export type PatternTester = (re: RegExp, value: string) => boolean;

let patternTester: PatternTester = (re, value) => re.test(value);

/**
 * Replace how variable patterns are evaluated (servers install a time-bounded tester). The tester
 * should throw or return false when the evaluation exceeds its budget.
 */
export function setPatternTester(fn: PatternTester) {
  patternTester = fn;
}

/** Test a value against an (already risk-checked) pattern using the installed tester; errors → false. */
export function testPattern(re: RegExp, value: string): boolean {
  try {
    return patternTester(re, value) === true;
  } catch {
    return false;
  }
}
