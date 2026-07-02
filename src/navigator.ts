import type { ArbNode, Json, NodeId, NodeKind, NodeMeta } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import { type Ref, NodeNotFoundError } from "./errors";
import { byteSize } from "./decompose";
import { matchGlob } from "./path-glob";
import { isWithin } from "./jsonpointer";

const DEFAULT_LIMIT = 100;
const PREVIEW_MAX = 50;

export interface NodeSummary {
  id: NodeId;
  path: string;
  key: string | number | null;
  kind: NodeKind;
  type?: string;
}

export interface ChildSummary {
  id: NodeId;
  key: string | number | null;
  kind: NodeKind;
  type?: string;
  hasChildren: boolean;
  size: number;
  preview: string;
}

export interface DescribeOpts {
  offset?: number;
  limit?: number;
}

export interface DescribeResult {
  node: NodeSummary;
  children: ChildSummary[];
  truncated?: { shown: number; total: number; nextOffset: number };
}

export interface GetOpts {
  maxDepth?: number;
}

export interface GetResult {
  id: NodeId;
  path: string;
  type?: string;
  content: Json;
  meta: NodeMeta;
  truncated?: boolean;
}

export interface FindSelector {
  type?: string;
  tag?: string;
  pathPattern?: string;
}

export interface FindOpts {
  limit?: number;
  /** JSON Pointer prefix: only nodes at/under it are hits — checked BEFORE the
   *  limit is consumed, so out-of-scope matches never eat the budget. */
  within?: string;
}

export interface FindHit {
  id: NodeId;
  path: string;
  type?: string;
}

export interface FindResult {
  hits: FindHit[];
  /** True when the walk stopped at `limit` — there MAY be more matches (an exact-fit
   *  final hit also reports true). */
  truncated: boolean;
}

function previewOf(node: ArbNode): string {
  if (node.kind === "leaf") {
    const s = JSON.stringify(node.content);
    return s.length <= PREVIEW_MAX ? s : s.slice(0, PREVIEW_MAX) + "…";
  }
  return node.kind === "array" ? `[${node.childIds.length} items]` : `{${node.childIds.length} keys}`;
}

/** Read-only navigation over the artifact tree: describe (cheap listing) and get (bounded content). */
export class Navigator {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
  ) {}

  protected resolve(ref: Ref): ArbNode {
    const node = "id" in ref ? this.addressing.byId(ref.id) : this.addressing.byPath(ref.path);
    if (!node) throw new NodeNotFoundError(ref);
    return node;
  }

  private summarize(node: ArbNode): ChildSummary {
    return {
      id: node.id,
      key: node.key,
      kind: node.kind,
      type: node.type,
      hasChildren: node.childIds.length > 0,
      size: node.kind === "leaf" ? byteSize(node.content) : node.childIds.length,
      preview: previewOf(node),
    };
  }

  describe(ref: Ref = { path: "" }, opts: DescribeOpts = {}): DescribeResult {
    const node = this.resolve(ref);
    const all = this.tree.children(node.id);
    const total = all.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const page = all.slice(offset, offset + limit);
    const result: DescribeResult = {
      node: {
        id: node.id,
        path: this.addressing.pathOf(node.id),
        key: node.key,
        kind: node.kind,
        type: node.type,
      },
      children: page.map((c) => this.summarize(c)),
    };
    const nextOffset = offset + page.length;
    if (nextOffset < total) {
      result.truncated = { shown: page.length, total, nextOffset };
    }
    return result;
  }

  get(ref: Ref, opts: GetOpts = {}): GetResult {
    const node = this.resolve(ref);
    const maxDepth = opts.maxDepth;
    let truncated = false;
    const reconstruct = (id: NodeId, depth: number): Json => {
      const n = this.tree.get(id)!;
      if (n.kind === "leaf") return n.content;
      if (maxDepth !== undefined && depth >= maxDepth) {
        truncated = true;
        const label = n.kind === "array" ? `${n.childIds.length} items` : `${n.childIds.length} keys`;
        return `[truncated: ${label}]`;
      }
      if (n.kind === "array") return n.childIds.map((cid) => reconstruct(cid, depth + 1));
      const obj: Record<string, Json> = {};
      for (const cid of n.childIds) {
        const c = this.tree.get(cid)!;
        obj[String(c.key)] = reconstruct(cid, depth + 1);
      }
      return obj;
    };
    const content = reconstruct(node.id, 0);
    const result: GetResult = {
      id: node.id,
      path: this.addressing.pathOf(node.id),
      type: node.type,
      content,
      meta: node.meta,
    };
    if (truncated) result.truncated = true;
    return result;
  }

  private matches(node: ArbNode, sel: FindSelector): boolean {
    if (sel.type !== undefined && node.type !== sel.type) return false;
    if (sel.tag !== undefined && !(node.tags?.includes(sel.tag) ?? false)) return false;
    if (sel.pathPattern !== undefined && !matchGlob(sel.pathPattern, this.addressing.pathOf(node.id))) {
      return false;
    }
    return true;
  }

  /** Find nodes matching ALL provided selector fields (exact `type`, `tag` membership, glob `pathPattern`). */
  find(selector: FindSelector, opts: FindOpts = {}): FindResult {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const within = opts.within;
    const hits: FindHit[] = [];
    let truncated = false;
    const visit = (id: NodeId): void => {
      if (hits.length >= limit) {
        truncated = true;
        return;
      }
      const node = this.tree.get(id)!;
      if (this.matches(node, selector)) {
        const path = this.addressing.pathOf(node.id);
        if (isWithin(path, within)) {
          hits.push({ id: node.id, path, type: node.type });
        }
      }
      for (const cid of node.childIds) {
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        visit(cid);
      }
    };
    visit(this.tree.rootIdValue());
    return { hits, truncated };
  }
}
