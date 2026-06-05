export interface Clock {
  now(): number; // epoch milliseconds
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Deterministic test double: constant value, manually advanced. */
export class FixedClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
