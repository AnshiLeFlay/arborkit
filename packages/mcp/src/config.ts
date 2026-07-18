import type { Arbor } from "arborkit";
import type { ArborMcpServerOptions } from "./server";

export interface ArborMcpConfig extends Omit<ArborMcpServerOptions, "arbor"> {
  createArbor(): Arbor | Promise<Arbor>;
}

export function defineArborMcpConfig<T extends ArborMcpConfig>(config: T): T {
  return config;
}

export async function resolveArborMcpConfig(config: ArborMcpConfig): Promise<ArborMcpServerOptions> {
  const { createArbor, ...options } = config;
  return { ...options, arbor: await createArbor() };
}
