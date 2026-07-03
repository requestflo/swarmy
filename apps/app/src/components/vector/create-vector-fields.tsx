import * as React from 'react';
import { Input, Label } from '@swarmy/ui';

export interface VectorDraft {
  stack: string;
  name: string;
}

export const EMPTY_VECTOR_DRAFT: VectorDraft = {
  stack: '',
  name: 'vectors',
};

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}

/** The create-vector fields (stack / name), extracted from the old dialog. */
export function CreateVectorFields({
  draft,
  onChange,
  hideStack = false,
}: {
  draft: VectorDraft;
  onChange: (next: VectorDraft) => void;
  /** Hide the stack input when the stack comes from the workspace route. */
  hideStack?: boolean;
}): React.JSX.Element {
  const set = (patch: Partial<VectorDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid grid-cols-2 gap-3">
      {hideStack ? null : (
        <Field label="Stack">
          <Input value={draft.stack} onChange={(e) => set({ stack: e.target.value })} placeholder="shop" />
        </Field>
      )}
      <Field label="Name">
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="vectors" />
      </Field>
    </div>
  );
}
