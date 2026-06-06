import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ArtifactTree } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";
import { typeAwareDecision } from "../src/type-aware-decision";
import { zodValidate } from "../src/zod-adapter";
import { ValidationError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const PageContent = z.object({ title: z.string(), body: z.string() });

function setup() {
  const registry = new TypeRegistry();
  registry.register("PageContent", { validate: zodValidate(PageContent, "PageContent"), decompose: "opaque" });
  const clock = new FixedClock(0);
  // small base threshold so the untyped scaffold decomposes; the typed node is forced opaque by its type
  const decision = typeAwareDecision(sizeBasedDecision(3), registry);
  const tree = ArtifactTree.fromJson({ a: 1 }, { idGen: new SeqIdGen(), clock, decision });
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate: makeRegistryValidator(registry) });
  return { tree, log, mutator };
}

describe("M3 schema-optional integration", () => {
  it("accepts a valid typed insert, stores it opaque, types it, and logs it", () => {
    const { tree, log, mutator } = setup();
    const id = mutator.insert({ path: "" }, "home", { title: "Home", body: "<h1>Hi</h1>" }, { type: "PageContent" });
    expect(tree.get(id)!.type).toBe("PageContent");
    expect(tree.get(id)!.kind).toBe("leaf"); // decompose override -> opaque
    expect(tree.toJson()).toEqual({ a: 1, home: { title: "Home", body: "<h1>Hi</h1>" } });
    expect(log.length()).toBe(1);
  });

  it("rejects an invalid typed insert with ValidationError and changes nothing", () => {
    const { tree, log, mutator } = setup();
    expect(() =>
      mutator.insert({ path: "" }, "bad", { title: "missing body" }, { type: "PageContent" }),
    ).toThrow(ValidationError);
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(log.length()).toBe(0);
  });
});
