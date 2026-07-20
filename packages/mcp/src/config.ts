import type { Arbor, DurableArborSession } from "arborkit";
import type { ArborMcpServerOptions } from "./server";

export interface ArborMcpConfig extends Omit<ArborMcpServerOptions, "arbor" | "session"> {
  createArbor(): Arbor | DurableArborSession | Promise<Arbor | DurableArborSession>;
}

export function defineArborMcpConfig<T extends ArborMcpConfig>(config: T): T {
  return config;
}

export async function resolveArborMcpConfig(config: ArborMcpConfig): Promise<ArborMcpServerOptions> {
  const { createArbor, ...options } = config;
  const value = await createArbor();
  return value instanceof Object && "kind" in value && value.kind === "durable-arbor-session"
    ? { ...options, session: value as DurableArborSession }
    : { ...options, arbor: value as Arbor };
}
