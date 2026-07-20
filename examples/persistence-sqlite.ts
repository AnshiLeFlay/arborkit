import { openDurableArbor, sizeBasedDecision } from "arborkit";
import { SqliteDurableStore } from "@arborkit/sqlite";

const store = new SqliteDurableStore({ filename: ":memory:" });
store.migrate();
const session = await openDurableArbor({
  artifactId: "example",
  store,
  config: { decomposition: { id: "size-based", version: "1" } },
  arbor: { initial: { pages: {} }, decompose: sizeBasedDecision(1) },
  closeStoreOnClose: true,
});

await session.transact({}, (arbor) => arbor.toolset().patch(
  { path: "/pages" },
  { op: "insert", key: "home", value: { title: "Durable home" } },
));
console.log(JSON.stringify(session.arbor.tree.toJson(), null, 2));
await session.close();
