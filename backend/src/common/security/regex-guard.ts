import { setPatternTester } from '@cf/shared';
import * as vm from 'node:vm';

/**
 * Time-bounded evaluation of author-supplied regular expressions against untrusted input.
 * V8 honours vm timeouts inside the regex engine, so a pattern with catastrophic backtracking is
 * interrupted after REGEX_BUDGET_MS instead of blocking the event loop for every tenant.
 */
export const REGEX_BUDGET_MS = 50;

const context = vm.createContext(Object.create(null));
const script = new vm.Script('re.test(s)');

/** true/false for a match; throws when the budget is exceeded (callers treat that as "no match"). */
export function boundedRegexTest(re: RegExp, value: string, budgetMs = REGEX_BUDGET_MS): boolean {
  const ctx = context as { re?: RegExp; s?: string };
  ctx.re = re;
  ctx.s = value;
  try {
    return script.runInContext(context, { timeout: budgetMs }) === true;
  } finally {
    ctx.re = undefined;
    ctx.s = undefined;
  }
}

// Install for @cf/shared resolveVariables (runtime variable `pattern`). Importing this module is enough.
setPatternTester((re, value) => boundedRegexTest(re, value));
