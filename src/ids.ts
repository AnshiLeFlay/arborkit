import { randomUUID } from "node:crypto";
import type { NodeId } from "./types";

export interface IdGen {
  next(): NodeId;
}

export class UuidIdGen implements IdGen {
  next(): NodeId {
    return randomUUID();
  }
}

/** Wrap an idGen so it never mints an id already present in `used` (and records
 *  what it mints). Restores preserve stored node ids, so a deterministic
 *  generator (e.g. SeqIdGen) restarted in a new process would otherwise re-mint
 *  a live id — a collision silently overwrites a live node in the node map and
 *  corrupts the parent chain into a cycle (`pathOf` then never terminates).
 *  Skipped-over ids simply advance deterministic generators past them. */
export function guardIdGen(idGen: IdGen, used: Set<NodeId>): IdGen {
  return {
    next: () => {
      let id = idGen.next();
      while (used.has(id)) id = idGen.next();
      used.add(id);
      return id;
    },
  };
}

/** Deterministic test double: n0, n1, n2, ... */
export class SeqIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = "n") {}
  next(): NodeId {
    return `${this.prefix}${this.n++}`;
  }
}
