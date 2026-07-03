import type { Json } from "./types";
import { parsePointer } from "./jsonpointer";

/** Read the value at a JSON Pointer, or undefined if any segment is missing. */
export function getAtPath(value: Json, pointer: string): Json | undefined {
  const segs = parsePointer(pointer);
  let cur: Json | undefined = value;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) && i >= 0 && i < cur.length ? cur[i] : undefined;
    } else if (cur !== null && typeof cur === "object") {
      cur = seg in cur ? (cur as Record<string, Json>)[seg] : undefined;
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Navigate (within `root`) to the container holding the pointer's last segment. */
function navParent(root: Json, pointer: string): { parent: Json; key: string } | undefined {
  const segs = parsePointer(pointer);
  if (segs.length === 0) return undefined;
  let cur: Json | undefined = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (cur !== null && typeof cur === "object") cur = (cur as Record<string, Json>)[seg];
    else return undefined;
    if (cur === undefined || cur === null) return undefined;
  }
  return { parent: cur, key: segs[segs.length - 1] };
}

/** In-place variant of setAtPath: mutates `value` (root pointer returns `newVal`). */
export function setAtPathMut(value: Json, pointer: string, newVal: Json): Json {
  if (pointer === "") return newVal;
  const pk = navParent(value, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return value;
  if (Array.isArray(pk.parent)) pk.parent[Number(pk.key)] = newVal;
  else (pk.parent as Record<string, Json>)[pk.key] = newVal;
  return value;
}

/** In-place variant of removeAtPath: mutates `value` (root pointer returns null). */
export function removeAtPathMut(value: Json, pointer: string): Json {
  if (pointer === "") return null;
  const pk = navParent(value, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return value;
  if (Array.isArray(pk.parent)) pk.parent.splice(Number(pk.key), 1);
  else delete (pk.parent as Record<string, Json>)[pk.key];
  return value;
}

/** In-place variant of insertAtPath: mutates `value` (root pointer returns `val`). */
export function insertAtPathMut(value: Json, pointer: string, val: Json): Json {
  if (pointer === "") return val;
  const pk = navParent(value, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return value;
  if (Array.isArray(pk.parent)) pk.parent.splice(Number(pk.key), 0, val);
  else (pk.parent as Record<string, Json>)[pk.key] = val;
  return value;
}

/** Return a copy of `value` with the value at `pointer` replaced (root → returns `newVal`). */
export function setAtPath(value: Json, pointer: string, newVal: Json): Json {
  return setAtPathMut(structuredClone(value), pointer, newVal);
}

/** Return a copy of `value` with the element at `pointer` removed (object delete / array splice). */
export function removeAtPath(value: Json, pointer: string): Json {
  return removeAtPathMut(structuredClone(value), pointer);
}

/** Return a copy of `value` with `val` inserted at `pointer` (object set / array splice-in). */
export function insertAtPath(value: Json, pointer: string, val: Json): Json {
  return insertAtPathMut(structuredClone(value), pointer, val);
}
