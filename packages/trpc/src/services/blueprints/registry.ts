import { BLUEPRINT_CATALOG, type BlueprintEntry } from './catalog';
import { TEMPLATE_ENTRIES } from './from-app-config';

/**
 * The whole gallery: the hand-written generators first (bring-your-own-app
 * shapes + WordPress/n8n/Directus), then the `@swarmy/templates` app catalogue.
 */
export const ALL_BLUEPRINTS: BlueprintEntry[] = [...BLUEPRINT_CATALOG, ...TEMPLATE_ENTRIES];

/** Resolve a gallery id, or undefined for an unknown slug. */
export function findBlueprint(id: string): BlueprintEntry | undefined {
  return ALL_BLUEPRINTS.find((e) => e.meta.id === id);
}
