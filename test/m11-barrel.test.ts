import { describe, it, expect } from "vitest";
import * as arbor from "../src/index";

describe("M11: barrel exports the public surface", () => {
  it("exposes the core classes and factories", () => {
    expect(typeof arbor.ArtifactTree).toBe("function");
    expect(typeof arbor.Addressing).toBe("function");
    expect(typeof arbor.EventLog).toBe("function");
    expect(typeof arbor.Mutator).toBe("function");
    expect(typeof arbor.Navigator).toBe("function");
    expect(typeof arbor.SemanticIndex).toBe("function");
    expect(typeof arbor.Replay).toBe("function");
    expect(typeof arbor.TypeRegistry).toBe("function");
    expect(typeof arbor.MemoryVectorIndex).toBe("function");
    expect(typeof arbor.MockEmbeddingPort).toBe("function");
    expect(typeof arbor.MemoryStorage).toBe("function");
    expect(typeof arbor.FileStorage).toBe("function");
  });

  it("exposes the function API", () => {
    expect(typeof arbor.makeToolset).toBe("function");
    expect(typeof arbor.serializeArtifact).toBe("function");
    expect(typeof arbor.restoreArtifact).toBe("function");
    expect(typeof arbor.zodValidate).toBe("function");
    expect(typeof arbor.makeRegistryValidator).toBe("function");
    expect(typeof arbor.typeAwareDecision).toBe("function");
    expect(typeof arbor.sizeBasedDecision).toBe("function");
    expect(typeof arbor.toEmbeddingText).toBe("function");
    expect(typeof arbor.matchGlob).toBe("function");
    expect(typeof arbor.getAtPath).toBe("function");
    expect(typeof arbor.buildPointer).toBe("function");
    expect(typeof arbor.SeqIdGen).toBe("function");
    expect(typeof arbor.SystemClock).toBe("function");
    expect(typeof arbor.ArborError).toBe("function");
  });
});
