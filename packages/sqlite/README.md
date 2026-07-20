# @arborkit/sqlite

Alpha SQLite persistence for ArborKit. Run `store.migrate()` explicitly before opening an artifact.

```js
import { openDurableArbor } from "arborkit";
import { SqliteDurableStore } from "@arborkit/sqlite";

const store = new SqliteDurableStore({ filename: "./arbor.db" });
store.migrate();
const session = await openDurableArbor({
  artifactId: "demo",
  store,
  config: { decomposition: { id: "size-based", version: "1" } },
});
```

The optional vector adapter has a separate export so SQLite persistence does not
load `sqlite-vec`:

```js
import { SqliteVecIndex } from "@arborkit/sqlite/sqlite-vec";
```

`1.6.0-alpha` schemas and APIs may change between alpha releases. Back up important data.
