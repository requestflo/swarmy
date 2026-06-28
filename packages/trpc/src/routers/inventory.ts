import { buildInventory } from '@swarmy/core';
import { router, orgProcedure } from '../trpc';

/**
 * Live inventory — the single read API for the Applications canvas.
 *
 * Docker is the source of truth: this reads the org's live services + containers
 * straight from the controller's in-memory hub (fed by the agent), projects them
 * into Project(=Docker stack) → Service → Container, and infers links. No DB.
 */
export const inventoryRouter = router({
  get: orgProcedure.query(({ ctx }) => {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    return buildInventory(services, containers);
  }),
});
