import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@swarmy/ui';
import { CodeEntryForm } from './code-entry-form';
import { verifySecondFactor } from './two-factor-api';

export type StepUpReason = 'MFA_STEP_UP_REQUIRED' | 'MFA_ENROLMENT_REQUIRED';

interface StepUpDialogProps {
  reason: StepUpReason | null;
  onClose: () => void;
  /** Called after a good code: retry whatever needed the step-up. */
  onVerified: () => void;
}

/**
 * Terminal step-up (TerminalPolicy.requireMfa). A good code stamps this
 * session's mfaVerifiedAt, so the retried open passes for the policy window.
 */
export function StepUpDialog({ reason, onClose, onVerified }: StepUpDialogProps): React.JSX.Element {
  return (
    <Dialog open={reason !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Confirm it’s you</DialogTitle>
          <DialogDescription>
            {reason === 'MFA_ENROLMENT_REQUIRED'
              ? 'Opening a shell here requires two-factor authentication. Set up an authenticator app first.'
              : 'Opening a shell requires a recent second factor. Enter a code from your authenticator app.'}
          </DialogDescription>
        </DialogHeader>
        {reason === 'MFA_ENROLMENT_REQUIRED' ? (
          <Button asChild>
            <Link to="/settings/access">Set up two-factor</Link>
          </Button>
        ) : (
          <CodeEntryForm
            submitLabel="Verify and connect"
            onSubmit={async (code, kind) => {
              await verifySecondFactor(code, kind);
              onClose();
              onVerified();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
