import { orgProcedure, router } from '../trpc';
import { overview } from '../services/registryPolicy.service';

/**
 * Registry policy — image CVE scans (trivy), cosign signing, admission toggles (slice D3). Spine stub — slice D3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const registryPolicyRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
