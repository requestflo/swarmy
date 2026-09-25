import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@swarmy/ui';
import { PolicyActionPicker } from './policy-action-picker';
import { PolicyScopeFields } from './policy-scope-fields';
import { PolicyWhoFields } from './policy-who-fields';
import { usePolicyEditor, type PolicyRow } from './use-policy-editor';

interface PolicyRuleEditorProps {
  /** The rule to edit, or null for a new one. */
  initial: PolicyRow | null;
  onClose: () => void;
}

/** Build a rule as WHO × CAN × WHERE, with a live plain-words preview. */
export function PolicyRuleEditor({ initial, onClose }: PolicyRuleEditorProps): React.JSX.Element {
  const e = usePolicyEditor(initial, onClose);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>
            Rules combine: any &ldquo;never&rdquo; rule wins, otherwise one &ldquo;can&rdquo; rule is enough.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 text-sm">
          <div className="bg-muted rounded-xl px-4 py-3">
            <span className="mono-label text-muted-foreground">Reads as</span>
            <p className="mt-1 font-medium">
              {'sentence' in e.preview ? e.preview.sentence : <span className="text-destructive">{e.preview.error}</span>}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="grid gap-1.5">
              <Label>Name (optional)</Label>
              <Input aria-label="Name (optional)" value={e.draft.name} onChange={(ev) => e.patch({ name: ev.target.value })} placeholder="Platform team ships prod" />
            </div>
            <div className="grid gap-1.5">
              <Label>Effect</Label>
              <Select value={e.draft.effect} onValueChange={(v) => e.patch({ effect: v as 'permit' | 'forbid' })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="permit">can</SelectItem>
                  <SelectItem value="forbid">can never</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Input aria-label="Priority"
                type="number"
                className="w-24"
                value={e.priority}
                onChange={(ev) => e.setPriority(Number(ev.target.value) || 0)}
              />
            </div>
          </div>

          {e.jsonMode ? (
            <div className="grid gap-1.5">
              <Label>Rule (JSON)</Label>
              <Textarea className="font-mono text-xs" rows={10} value={e.source} onChange={(ev) => e.setSource(ev.target.value)} />
            </div>
          ) : (
            <>
              <PolicyWhoFields draft={e.draft} patch={e.patch} />
              <PolicyActionPicker value={e.draft.actions} onChange={(actions) => e.patch({ actions })} />
              <PolicyScopeFields draft={e.draft} patch={e.patch} />
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {!e.jsonMode ? (
            <Button variant="ghost" onClick={e.toJson}>
              Edit as JSON
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={e.submit} disabled={e.saving || 'error' in e.preview}>
              {e.saving && <Loader2Icon className="animate-spin" />} Save rule
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
