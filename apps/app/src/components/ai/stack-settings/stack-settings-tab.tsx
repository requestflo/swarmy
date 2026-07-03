import * as React from 'react';
import { StackAddServiceCard } from './stack-add-service-card';
import { StackAiAccessCard } from './stack-ai-access-card';
import { StackDangerZone } from './stack-danger-zone';
import { StackEnvironmentCard } from './stack-environment-card';
import { StackOutletCard } from './stack-outlet-card';

interface StackSettingsTabProps {
  stack: string;
}

/**
 * The stack Settings tab: environment marking (guardrails), AI gateway access
 * + outlet exposure, add-service, and the danger zone. Everything inline —
 * the only modal on this screen is the destructive remove-stack confirm.
 */
export function StackSettingsTab({ stack }: StackSettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-2">
          <StackEnvironmentCard stack={stack} />
          <StackAddServiceCard stack={stack} />
        </div>
        <div className="space-y-4 xl:col-span-3">
          <StackAiAccessCard stack={stack} />
          <StackOutletCard stack={stack} />
        </div>
      </div>
      <StackDangerZone stack={stack} />
    </div>
  );
}
