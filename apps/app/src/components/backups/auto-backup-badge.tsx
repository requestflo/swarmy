import * as React from 'react';
import { Badge } from '@swarmy/ui';

interface AutoBackupBadgeProps {
  retentionDays: number | null;
  /** Renders the "(change)" affordance — a link or a button, owner's choice. */
  change?: React.ReactNode;
}

/**
 * "Auto — nightly, keep 7 (change)": the schedule was created by swarmy's
 * default-on database backups, not by a user. Changing it hands ownership to
 * the user; removing it opts the database out for good.
 */
export function AutoBackupBadge({ retentionDays, change }: AutoBackupBadgeProps): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="info" title="Created automatically by swarmy's default-on database backups">
        Auto — nightly, keep {retentionDays ?? 7}
      </Badge>
      {change}
    </span>
  );
}
