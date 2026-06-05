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

/** Parse a JSON Pointer into decoded segments. "" => [] (root). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer (must be "" or start with "/"): ${pointer}`);
  }
  return pointer.slice(1).split("/").map(decodeSegment);
}
