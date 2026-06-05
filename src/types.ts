export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type NodeId = string;
export type NodeKind = "object" | "array" | "leaf";

export interface NodeMeta {
  version: number;
  updatedAt: number;
  owner?: string;
  embedding: { state: "fresh" | "stale" | "none"; textHash?: string; vecRef?: string };
}

export interface ArbNode {
  id: NodeId;
  parentId: NodeId | null;
  key: string | number | null; // null only for the root
  kind: NodeKind;
  content: Json | null; // leaf: the value/opaque subtree; object|array: null
  childIds: NodeId[]; // ordered children (order is significant for arrays)
  tags?: string[];
  type?: string;
  meta: NodeMeta;
}
