import type { ArbNode, NodeId } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import { InvalidOpError } from "./errors";
import { buildPointer, parsePointer } from "./jsonpointer";

/**
 * Resolves nodes by stable id and by JSON Pointer path.
 * `path` is DERIVED from the current structure (not stored), so it stays
 * consistent automatically — id is identity, path is current location.
 */
export class Addressing {
  constructor(private readonly tree: ArtifactTree) {}

  byId(id: NodeId): ArbNode | undefined {
    return this.tree.get(id);
  }

  /** Compute the JSON Pointer for a node by walking parent links to the root. */
  pathOf(id: NodeId): string {
    const cur0 = this.tree.get(id);
    if (!cur0) throw new Error(`Unknown node: ${id}`);
    const segments: (string | number)[] = [];
    const seen = new Set<NodeId>(); // insurance against corrupted parent links — a cycle would hang this sync loop
    let cur: ArbNode | undefined = cur0;
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) {
        throw new InvalidOpError(`parent chain cycle at node ${cur.id} while resolving path of ${id}`);
      }
      seen.add(cur.id);
      segments.unshift(cur.key as string | number);
      cur = this.tree.get(cur.parentId);
    }
    return buildPointer(segments);
  }

  /** Resolve a JSON Pointer to a node, or undefined if any segment is missing. */
  byPath(pointer: string): ArbNode | undefined {
    const segments = parsePointer(pointer);
    let cur: ArbNode | undefined = this.tree.root();
    for (const seg of segments) {
      if (!cur) return undefined;
      // parsePointer yields UNescaped segments and node keys are raw strings —
      // they match childByKey's String(key) map keys directly.
      cur = this.tree.childByKey(cur.id, seg);
      if (!cur) return undefined;
    }
    return cur;
  }
}
