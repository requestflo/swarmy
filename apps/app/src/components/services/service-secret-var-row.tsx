import * as React from 'react';
import { EyeIcon, EyeOffIcon, KeyRoundIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import type { ServiceSecretVarView } from '@swarmy/core';
import { Button, CopyButton } from '@swarmy/ui';
import { relativeTime } from '@/components/releases/release-status';
import { SecretVarForm, type SecretDelivery } from './secret-var-form';

interface ServiceSecretVarRowProps {
  v: ServiceSecretVarView;
  revealed: string | null;
  pending: boolean;
  onSave: (value: string | undefined, delivery: SecretDelivery) => void;
  onRemove: () => void;
  onReveal: () => void;
  onHide: () => void;
}

/** One write-only secret: "set · updated 3d ago by X", replace / reveal / remove. */
export function ServiceSecretVarRow({ v, revealed, pending, onSave, onRemove, onReveal, onHide }: ServiceSecretVarRowProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);

  return (
    <li className="grid gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-mono text-sm font-semibold break-all">{v.key}</span>
        <span className="mono-label text-muted-foreground">{v.delivery === 'env' ? 'env' : `${v.key}_FILE`}</span>
        <span className="text-muted-foreground text-xs">
          set · v{v.version} · updated {relativeTime(v.updatedAt)}
          {v.updatedBy ? ` by ${v.updatedBy}` : ''}
          {v.pendingCleanup > 0 ? ' · old version removed after rollout' : ''}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" title={revealed ? 'Hide' : 'Reveal (audited)'} onClick={revealed ? onHide : onReveal}>
            {revealed ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" title="Replace value" onClick={() => setEditing((e) => !e)}>
            <PencilIcon className="size-4" />
          </Button>
          {confirm ? (
            <Button variant="outline" size="sm" className="border-status-offline text-status-offline rounded-full" disabled={pending} onClick={onRemove}>
              Remove {v.key}?
            </Button>
          ) : (
            <Button variant="ghost" size="icon" title="Remove" className="hover:text-status-offline" onClick={() => setConfirm(true)}>
              <Trash2Icon className="size-4" />
            </Button>
          )}
        </span>
      </div>
      {revealed !== null && (
        <div className="bg-muted flex items-start gap-2 rounded-xl p-2">
          <pre className="mono-data min-w-0 flex-1 overflow-x-auto text-xs whitespace-pre-wrap break-all">{revealed}</pre>
          <CopyButton value={revealed} />
        </div>
      )}
      {editing && (
        <SecretVarForm
          fixedKey={v.key}
          initialDelivery={v.delivery}
          pending={pending}
          onCancel={() => setEditing(false)}
          onSubmit={({ value, delivery }) => {
            onSave(value, delivery);
            setEditing(false);
          }}
        />
      )}
    </li>
  );
}
