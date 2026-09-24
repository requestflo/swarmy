import * as React from 'react';
import { Button, CopyButton, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@swarmy/ui';
import { BackupCodesPanel } from './backup-codes-panel';
import { CodeEntryForm } from './code-entry-form';
import { PasswordStep } from './password-step';
import { QrCode } from './qr-code';
import { secretFromUri, startEnrolment, verifySecondFactor } from './two-factor-api';

interface EnrolTwoFactorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Password accounts re-enter it; SSO / magic-link-only accounts skip the step. */
  hasPassword: boolean;
  onEnrolled: () => void;
}

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; totpURI: string; backupCodes: string[] }
  | { kind: 'codes'; backupCodes: string[] };

/** Enrolment: (password) → scan QR / type secret → confirm a code → backup codes. */
export function EnrolTwoFactorDialog({
  open,
  onOpenChange,
  hasPassword,
  onEnrolled,
}: EnrolTwoFactorDialogProps): React.JSX.Element {
  const [step, setStep] = React.useState<Step>({ kind: 'password' });
  const [startError, setStartError] = React.useState<string | null>(null);

  const begin = React.useCallback(async (password?: string) => {
    const res = await startEnrolment(password);
    setStep({ kind: 'scan', ...res });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setStep({ kind: 'password' });
    setStartError(null);
    if (!hasPassword) begin().catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)));
  }, [open, hasPassword, begin]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set up an authenticator app</DialogTitle>
          <DialogDescription>
            {step.kind === 'codes'
              ? 'Two-factor is on.'
              : 'Use any TOTP app: 1Password, Google Authenticator, Authy, Bitwarden…'}
          </DialogDescription>
        </DialogHeader>
        {startError && <p className="text-destructive text-sm">{startError}</p>}
        {step.kind === 'password' && hasPassword && <PasswordStep submitLabel="Continue" onSubmit={begin} />}
        {step.kind === 'scan' && (
          <div className="space-y-4">
            <div className="flex justify-center">
              <QrCode value={step.totpURI} label="Authenticator enrolment QR code" />
            </div>
            <div className="text-muted-foreground text-sm">
              Can’t scan? Enter this key by hand:
              <div className="mt-1 flex items-center gap-2">
                <code className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">
                  {secretFromUri(step.totpURI)}
                </code>
                <CopyButton value={secretFromUri(step.totpURI).replace(/\s/g, '')} />
              </div>
            </div>
            <CodeEntryForm
              totpOnly
              submitLabel="Turn on two-factor"
              onSubmit={async (code) => {
                await verifySecondFactor(code, 'totp');
                setStep({ kind: 'codes', backupCodes: step.backupCodes });
                onEnrolled();
              }}
            />
          </div>
        )}
        {step.kind === 'codes' && (
          <div className="space-y-4">
            <BackupCodesPanel codes={step.backupCodes} />
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              I’ve saved them
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
