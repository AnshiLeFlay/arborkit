import { createArbor, sizeBasedDecision } from "arborkit";
import { defineArborMcpConfig } from "@arborkit/mcp";

export default defineArborMcpConfig({
  artifactId: "content-site",
  profile: "editor",
  binding: {
    owner: "mcp:content-editor",
    readScope: "/pages",
    writeScope: "/pages",
  },
  createArbor() {
    return createArbor({
      initial: { pages: { home: { title: "Home", body: "Welcome" } }, plan: "" },
      decompose: sizeBasedDecision(1),
    });
  },
});
