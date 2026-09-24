import * as React from 'react';
import { STEP_UP_CODES, swarmyCodeOf } from './two-factor-api';
import type { StepUpReason } from './step-up-dialog';

/**
 * Wire a mutation's onError to the step-up dialog: `intercept(e)` returns true
 * (and opens the dialog) when the server refused for a missing/stale second
 * factor; `retry` is re-run after a good code.
 */
export function useStepUp(retry: () => void): {
  intercept: (e: unknown) => boolean;
  dialog: { reason: StepUpReason | null; onClose: () => void; onVerified: () => void };
} {
  const [reason, setReason] = React.useState<StepUpReason | null>(null);
  const intercept = React.useCallback((e: unknown): boolean => {
    const code = swarmyCodeOf(e);
    if (!code || !(STEP_UP_CODES as readonly string[]).includes(code)) return false;
    setReason(code as StepUpReason);
    return true;
  }, []);
  return {
    intercept,
    dialog: { reason, onClose: () => setReason(null), onVerified: retry },
  };
}
