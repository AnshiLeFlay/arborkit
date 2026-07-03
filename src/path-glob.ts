import { parsePointer } from "./jsonpointer";

/** Match parsed segment arrays. `*` = one segment; `**` = zero or more segments. */
function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (head === "*" || head === path[0]) {
    return matchSegments(rest, path.slice(1));
  }
  return false;
}

/**
 * Parse a glob `pattern` ONCE and return a reusable matcher over JSON Pointer paths.
 * `*` matches exactly one path segment; `**` matches zero or more segments.
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const patternSegs = parsePointer(pattern);
  return (path: string) => matchSegments(patternSegs, parsePointer(path));
}

/**
 * Glob-match a JSON Pointer `path` against a `pattern`.
 * `*` matches exactly one path segment; `**` matches zero or more segments.
 * One-shot convenience over `compileGlob` — prefer compiling when matching many paths.
 */
export function matchGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern)(path);
}
