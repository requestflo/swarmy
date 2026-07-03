import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Collapsible, CollapsibleContent, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackServiceSelect } from '@/components/secretsmgr/stack-service-select';
import { ConfigNameFields } from './config-name-fields';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

interface CreateConfigCardProps {
  stack: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Inline create card (no modal): name + stable mount path + readable content,
 * with an optional immediate attach onto one of THIS stack's services.
 */
export function CreateConfigCard({
  stack,
  open,
  onOpenChange,
}: CreateConfigCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [family, setFamily] = React.useState('');
  const [mountPath, setMountPath] = React.useState('');
  const [content, setContent] = React.useState('');
  const [service, setService] = React.useState('');

  const create = useMutation(trpc.configs.create.mutationOptions());
  const attach = useMutation(trpc.configs.attach.mutationOptions());
  const pending = create.isPending || attach.isPending;
  const ready =
    NAME_RE.test(family.trim()) &&
    family.trim().length <= 56 &&
    content.length > 0 &&
    (mountPath.trim() === '' || PATH_RE.test(mountPath.trim()));

  const submit = async (): Promise<void> => {
    try {
      const r = await create.mutateAsync({
        family: family.trim(),
        content,
        stack,
        ...(mountPath.trim() ? { mountPath: mountPath.trim() } : {}),
      });
      if (service) {
        try {
          await attach.mutateAsync({ family: r.family, service });
          toast.success(`${r.family} created and mounted into ${service} at ${r.mountPath}`);
        } catch (e) {
          toast.error(`${r.family} created, but attaching failed: ${(e as Error).message}`);
        }
      } else {
        toast.success(`Config ${r.family} created (v${r.version}) — attach it when ready`);
      }
      setFamily('');
      setMountPath('');
      setContent('');
      setService('');
      onOpenChange(false);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">New config</p>
            <p className="text-muted-foreground text-xs">
              A versioned Docker config, mounted at a stable path — edits are diffed, applies show
              exactly which services restart, and rollback is one click.
            </p>
          </div>
          <ConfigNameFields
            family={family}
            mountPath={mountPath}
            onFamily={setFamily}
            onMountPath={setMountPath}
          />
          <div className="grid gap-1.5">
            <p className="mono-label text-muted-foreground !mb-0">Content</p>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder={'# paste the file contents…'}
              className="mono-data resize-y whitespace-pre text-xs"
              spellCheck={false}
            />
          </div>
          <StackServiceSelect
            stack={stack}
            value={service}
            onChange={setService}
            label="Attach to service (optional)"
            emptyHint="No services in this stack yet — attach later."
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => void submit()} disabled={!ready || pending}>
              {pending ? 'Creating…' : service ? 'Create & attach' : 'Create config'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
