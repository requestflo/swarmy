import * as React from 'react';
import { CodeEntryForm } from '@/components/security/code-entry-form';
import { verifySecondFactor } from '@/components/security/two-factor-api';

interface LoginTwoFactorStepProps {
  /** Runs after the code is accepted (the session now exists). */
  onVerified: () => Promise<void>;
  onCancel: () => void;
}

/** Sign-in step 2 for 2FA accounts: an authenticator or backup code. */
export function LoginTwoFactorStep({ onVerified, onCancel }: LoginTwoFactorStepProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-medium">Two-factor code</h2>
        <p className="text-muted-foreground text-sm">Enter the 6-digit code from your authenticator app.</p>
      </div>
      <CodeEntryForm
        submitLabel="Sign in"
        onSubmit={async (code, kind) => {
          await verifySecondFactor(code, kind);
          await onVerified();
        }}
      />
      <button type="button" className="text-muted-foreground w-full text-center text-sm hover:underline" onClick={onCancel}>
        Back to sign in
      </button>
    </div>
  );
}
