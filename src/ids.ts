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

/** Deterministic test double: n0, n1, n2, ... */
export class SeqIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = "n") {}
  next(): NodeId {
    return `${this.prefix}${this.n++}`;
  }
}
