import * as React from 'react';
import { Label } from '@swarmy/ui';

/** Labelled field wrapper shared by the endpoint form sections. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** Kebab-case a name for the endpoint slug (matches the server slug rule). */
export const kebab = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
