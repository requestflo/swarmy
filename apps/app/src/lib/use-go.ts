import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';

/**
 * Navigate to a registry-driven destination by its (plain string) path.
 *
 * The destinations registry stores `to` as a string, which TanStack's typed
 * router won't accept directly; routes here are controlled by us and known to
 * exist, so the cast is sound. Detail routes with params navigate explicitly
 * instead of through this helper.
 */
export function useGo(): (to: string) => void {
  const navigate = useNavigate();
  return React.useCallback(
    (to: string) => {
      void navigate({ to: to as never });
    },
    [navigate],
  );
}
