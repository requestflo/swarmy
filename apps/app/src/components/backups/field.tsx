import * as React from 'react';
import { Label } from '@swarmy/ui';

interface FieldProps {
  label: string;
  /** Validation message — rendered in the offline tone beneath the control. */
  error?: string;
  children: React.ReactNode;
}

/** Mono-labelled form field — shared by the inline backup forms. */
export function Field({ label, error, children }: FieldProps): React.JSX.Element {
  return (
    <div className="grid content-start gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
      {error ? <p className="text-status-offline text-xs">{error}</p> : null}
    </div>
  );
}
