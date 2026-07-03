/** Escape a single reference token per RFC 6901: ~ -> ~0, / -> ~1. */
export function encodeSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Unescape a single reference token per RFC 6901: ~1 -> /, then ~0 -> ~. */
export function decodeSegment(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Build a JSON Pointer string. Empty segment list => "" (root). */
export function buildPointer(segments: ReadonlyArray<string | number>): string {
  if (segments.length === 0) return "";
  return "/" + segments.map((s) => encodeSegment(String(s))).join("/");
}

/** Append one child key to a parent pointer, escaping the key exactly as `buildPointer` does. */
export function appendPointer(parent: string, key: string | number): string {
  return parent + "/" + encodeSegment(String(key));
}

/** True when `path` is at or under `scope` (JSON Pointer prefix). Undefined scope = everywhere. */
export function isWithin(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(scope + "/");
}

/** Parse a JSON Pointer into decoded segments. "" => [] (root). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer (must be "" or start with "/"): ${pointer}`);
  }
  return pointer.slice(1).split("/").map(decodeSegment);
}
