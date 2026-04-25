// core/adapters/registry.ts — static map of adapter key → factory.
//
// Authority: ARCHITECTURE.md §4.1 (Adapter registry, A4 resolution: static
// map for bundler-friendliness, dead-code elimination, no runtime string
// injection). Adding a new adapter = one line here + the new module file.

import type { AdapterKey, SourceAdapter } from "../types.ts";
import { IcalAdapter } from "./ical.ts";

const ADAPTERS: Partial<Record<AdapterKey, () => SourceAdapter>> = {
  "ical": () => new IcalAdapter(),
  // Phase 5+: web-tangomango, web-nytango, web-tec, web-generic
  // Phase 6: fb-group
};

export function getAdapter(key: AdapterKey): SourceAdapter {
  const factory = ADAPTERS[key];
  if (!factory) {
    throw new Error(
      `Adapter "${key}" not registered. ` +
        `Available: ${Object.keys(ADAPTERS).join(", ") || "(none)"}`,
    );
  }
  return factory();
}

export function listRegisteredAdapters(): AdapterKey[] {
  return Object.keys(ADAPTERS) as AdapterKey[];
}
