/**
 * Side-effect stylesheet imports (`import './globals.css'`). Next.js compiles them; TypeScript 6 checks that
 * every side-effect import resolves to a module, so declare the pattern (module-scoped `*.module.css`
 * declarations from Next take precedence over this wildcard).
 */
declare module '*.css';
