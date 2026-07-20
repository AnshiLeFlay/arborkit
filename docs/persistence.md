# Durable persistence (`1.6.0-alpha`)

The entire `1.6.0-alpha.N` release line is test software. APIs and SQL schemas may
change between alpha builds. Install with the `alpha` dist-tag and keep backups.

## Backend roles

| Package | Role |
| --- | --- |
| `@arborkit/sqlite` | Embedded authoritative artifact store; optional sqlite-vec index. |
| `@arborkit/postgres` | Shared authoritative artifact store; optional pgvector index. |
| `@arborkit/qdrant` | Rebuildable external vector index; never the artifact source of truth. |

Both SQL stores separate artifacts by `artifactId`, use explicit forward-only
migrations, and atomically persist events, CAS version changes, and idempotency
records. A successful `DurableArborSession.transact()` means the SQL commit has
completed. Concurrent writers receive `STALE_ARTIFACT`; ArborKit reloads the
winning state but does not merge changes.

## SQLite quickstart

```ts
import { openDurableArbor, sizeBasedDecision } from "arborkit";
import { SqliteDurableStore } from "@arborkit/sqlite";

const store = new SqliteDurableStore({ filename: "./arborkit.db" });
store.migrate(); // explicit; constructors never run DDL

const session = await openDurableArbor({
  artifactId: "content",
  store,
  config: { decomposition: { id: "size-based", version: "1" } },
  arbor: { initial: { pages: {} }, decompose: sizeBasedDecision(1) },
  closeStoreOnClose: true,
});

await session.transact({}, (arbor) =>
  arbor.toolset().patch(
    { path: "/pages" },
    { op: "insert", key: "home", value: { title: "Home" } },
  ),
);
await session.checkpoint({ keepLast: 100 });
await session.close();
```

Do not mutate `session.arbor` directly. It is exposed for reads and adapter
compatibility; writes outside `transact()` are detected and discarded on the next
session operation.

## PostgreSQL and pgvector

```ts
import { Pool } from "pg";
import { PostgresDurableStore, PgVectorIndex } from "@arborkit/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresDurableStore({ pool });
await store.migrate();

const vectors = new PgVectorIndex({
  pool, artifactId: "content", dimensions: 1536, namespace: "embedding_v1",
});
await vectors.initialize({ installExtension: false });
```

`installExtension: false` is the default because application database users often
cannot run `CREATE EXTENSION`. Install pgvector administratively or opt in once.
One vector namespace has fixed dimensions; changing model dimensions requires a
new namespace and configuration fingerprint.

## Qdrant

```ts
import { QdrantVectorIndex } from "@arborkit/qdrant";

const vectors = new QdrantVectorIndex({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  collection: "arborkit",
  artifactId: "content",
  dimensions: 1536,
});
await vectors.ensureCollection();
```

Qdrant payloads contain `artifactId`, path scopes, type, tags, and text hash.
Filters run before top-k. If the collection is lost, open with
`vectorRecovery: "rebuild"` and call `session.reindex()`; SQL state remains intact.

## Idempotency and configuration

Pass both `idempotencyKey` and a canonical request hash. Repeating the same pair
returns the saved result without another mutation. Reusing a key for another hash
returns `IDEMPOTENCY_CONFLICT`.

The configuration identity records IDs and versions for decomposition, registry,
and embedding model/dimensions. The application still supplies the corresponding
runtime implementations. A mismatch is reported as `CONFIG_MISMATCH` before a
writable session is returned.

## Existing data

`importStoredArtifact()` imports v1/v2 JSON snapshots into an empty durable store.
Vectors are intentionally omitted and rebuilt. SQL migrations only move forward;
there is no automatic downgrade during the alpha series.
