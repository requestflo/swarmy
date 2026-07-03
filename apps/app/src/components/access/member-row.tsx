import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { Badge, Button, Collapsible, CollapsibleContent, Textarea, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { MemberEntry } from './access-shared';

interface MemberRowProps {
  member: MemberEntry;
  expanded: boolean;
  onToggle: () => void;
}

/** One member row; Edit expands the attributes JSON editor inline underneath. */
export function MemberRow({ member, expanded, onToggle }: MemberRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [text, setText] = React.useState(() => JSON.stringify(member.attributes, null, 2));

  React.useEffect(() => {
    if (expanded) setText(JSON.stringify(member.attributes, null, 2));
  }, [expanded, member.attributes]);

  const save = useMutation(
    trpc.members.setAttributes.mutationOptions({
      onSuccess: () => {
        toast.success('Attributes saved');
        onToggle();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <div className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_2fr_auto]">
        <div className="min-w-0">
          <p className="truncate font-medium">{member.user.email ?? member.user.name ?? member.id}</p>
          <p className="text-muted-foreground mono-label truncate sm:hidden">{member.role}</p>
        </div>
        <span className="hidden sm:block">
          <Badge variant="muted">{member.role}</Badge>
        </span>
        <span className="mono-data hidden truncate text-xs sm:block">
          {Object.keys(member.attributes).length ? JSON.stringify(member.attributes) : '—'}
        </span>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onToggle}>
            Edit
            <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>
      </div>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <div className="space-y-2 px-6 pb-5">
            <p className="text-muted-foreground text-xs">
              JSON object, e.g. {`{ "team": "payments", "onCall": true }`}
            </p>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onToggle}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={() => {
                  let parsed: Record<string, unknown>;
                  try {
                    parsed = JSON.parse(text);
                  } catch {
                    toast.error('Attributes must be valid JSON');
                    return;
                  }
                  save.mutate({ memberId: member.id, attributes: parsed });
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
