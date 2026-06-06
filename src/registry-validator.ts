import type { Validator } from "./mutator";
import type { TypeRegistry } from "./type-registry";

/** Build a Mutator `Validator` that runs the registered `validate()` for the node's type. */
export function makeRegistryValidator(registry: TypeRegistry): Validator {
  return ({ proposed, type }) => {
    if (type === undefined) return;
    registry.get(type)?.validate?.(proposed);
  };
}
