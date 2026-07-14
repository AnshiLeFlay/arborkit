import type { Json } from "./types";

/** Canonical JSON with recursively sorted object keys; array order is retained. */
export function canonicalize(value: Json): string {
  const normalize = (current: Json): Json => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      const result: Record<string, Json> = {};
      for (const key of Object.keys(current).sort()) {
        // defineProperty: assigning a "__proto__" key would hit the prototype
        // setter and silently drop it from the canonical form.
        Object.defineProperty(result, key, {
          value: normalize(current[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

/** Deterministic, non-cryptographic cyrb53 hash encoded as hexadecimal. */
export function hashString(value: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 2_654_435_761);
    low = Math.imul(low ^ code, 1_597_334_677);
  }
  high = Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
  low = Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
  return (4_294_967_296 * (2_097_151 & low) + (high >>> 0)).toString(16);
}

/** Hash exact canonical JSON. This returns identity data, not an equality verdict. */
export function structuralHash(value: Json): string {
  return hashString(canonicalize(value));
}

/** Describe JSON shape as tokens while ignoring scalar values. */
export function shapeTokens(value: Json): Set<string> {
  const result = new Set<string>();
  const visit = (current: Json, path: string): void => {
    if (Array.isArray(current)) {
      result.add(`${path}[]:${current.length}`);
      current.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (current !== null && typeof current === "object") {
      const keys = Object.keys(current).sort();
      result.add(`${path}{${keys.join(",")}}`);
      for (const key of keys) visit(current[key], `${path}.${key}`);
      return;
    }
    result.add(`${path}:${current === null ? "null" : typeof current}`);
  };
  visit(value, "");
  return result;
}

/** Jaccard similarity in [0, 1]. Two empty sets have similarity one. */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function hash32(value: string): number {
  return Number.parseInt(hashString(value).slice(-8), 16) >>> 0;
}

/** Seeded MinHash signature for approximate Jaccard comparison. */
export function minhashSignature(
  tokens: ReadonlySet<string>,
  opts: { numHashes?: number; seed?: number } = {},
): number[] {
  const numHashes = opts.numHashes ?? 64;
  if (!Number.isInteger(numHashes) || numHashes <= 0) {
    throw new Error("minhashSignature(): numHashes must be a positive integer");
  }
  const seed = opts.seed ?? 1;
  const signature = new Array<number>(numHashes).fill(0xffff_ffff);
  for (const token of tokens) {
    for (let index = 0; index < numHashes; index++) {
      const candidate = hash32(`${seed + index}:${token}`);
      if (candidate < signature[index]) signature[index] = candidate;
    }
  }
  return signature;
}

/** Fraction of equal positions in two MinHash signatures. */
export function minhashSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let equal = 0;
  for (let index = 0; index < length; index++) if (a[index] === b[index]) equal++;
  return equal / length;
}
