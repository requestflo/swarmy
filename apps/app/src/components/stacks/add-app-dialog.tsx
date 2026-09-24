import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface AddAppDialogProps {
  stack: string;
  /** Trigger label — the settings tab says "Add a service". */
  label?: string;
}

/**
 * "Add a service" inside an app: opens the one image form (`/services/new`)
 * with this app already chosen, so a single-image deploy has exactly one path.
 */
export function AddAppDialog({ stack, label = 'Add a service' }: AddAppDialogProps): React.JSX.Element {
  return (
    <Button asChild variant="outline" className="gap-2">
      <Link to="/services/new" search={{ stack }}>
        <PlusIcon className="size-4" />
        {label}
      </Link>
    </Button>
  );
}
