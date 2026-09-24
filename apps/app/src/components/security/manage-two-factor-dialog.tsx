import * as React from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@swarmy/ui';
import { BackupCodesPanel } from './backup-codes-panel';
import { CodeEntryForm } from './code-entry-form';
import { PasswordStep } from './password-step';
import { disableTwoFactor, regenerateBackupCodes, verifySecondFactor } from './two-factor-api';

export type ManageAction = 'disable' | 'regenerate';

interface ManageTwoFactorDialogProps {
  action: ManageAction | null;
  onClose: () => void;
  hasPassword: boolean;
  onChanged: () => void;
}

const COPY: Record<ManageAction, { title: string; description: string; cta: string }> = {
  disable: {
    title: 'Turn off two-factor',
    description: 'Confirm it is you. Your workspace may require two-factor; if so you will be asked to set it up again.',
    cta: 'Turn off two-factor',
  },
  regenerate: {
    title: 'New backup codes',
    description: 'Your old backup codes stop working as soon as new ones are made.',
    cta: 'Make new codes',
  },
};

/**
 * Re-auth-gated changes. Password accounts re-enter the password (the server
 * checks it); accounts without one prove possession with a current code first.
 */
export function ManageTwoFactorDialog({
  action,
  onClose,
  hasPassword,
  onChanged,
}: ManageTwoFactorDialogProps): React.JSX.Element {
  const [codes, setCodes] = React.useState<string[] | null>(null);
  React.useEffect(() => setCodes(null), [action]);
  const copy = action ? COPY[action] : COPY.disable;

  async function run(password?: string): Promise<void> {
    if (action === 'disable') {
      await disableTwoFactor(password);
      onChanged();
      onClose();
    } else {
      setCodes(await regenerateBackupCodes(password));
      onChanged();
    }
  }

  return (
    <Dialog open={action !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {codes ? (
          <div className="space-y-4">
            <BackupCodesPanel codes={codes} />
            <Button className="w-full" onClick={onClose}>
              I’ve saved them
            </Button>
          </div>
        ) : hasPassword ? (
          <PasswordStep submitLabel={copy.cta} onSubmit={run} />
        ) : (
          <CodeEntryForm
            submitLabel={copy.cta}
            onSubmit={async (code, kind) => {
              await verifySecondFactor(code, kind);
              await run();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
