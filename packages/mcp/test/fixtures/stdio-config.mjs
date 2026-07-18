import { createArbor } from "arborkit";
import { defineArborMcpConfig } from "../../dist/index.js";

export default defineArborMcpConfig({
  artifactId: "cli-fixture",
  profile: "reader",
  createArbor() {
    return createArbor({ initial: { message: "stdio works" } });
  },
});
