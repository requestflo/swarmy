import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { RuleDraft, Who } from './policy-draft';

interface PolicyWhoFieldsProps {
  draft: RuleDraft;
  patch: (p: Partial<RuleDraft>) => void;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors',
        on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

const toggle = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function groupsOf(attributes: Record<string, unknown>): string[] {
  return ['groups', 'ssoGroups', 'teamIds'].flatMap((k) => {
    const v = attributes[k];
    return Array.isArray(v) ? v.map(String) : [];
  });
}

/** WHO a rule applies to: everyone, a role, members of a group, or named people. */
export function PolicyWhoFields({ draft, patch }: PolicyWhoFieldsProps): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.members.list.queryOptions());
  const known = [...new Set((members.data ?? []).flatMap((m) => groupsOf(m.attributes)))].sort();
  const [groupText, setGroupText] = React.useState('');

  const addGroup = (): void => {
    const g = groupText.trim();
    if (g && !draft.groups.includes(g)) patch({ groups: [...draft.groups, g] });
    setGroupText('');
  };

  return (
    <div className="grid gap-2">
      <Label>Who</Label>
      <Select value={draft.who} onValueChange={(v) => patch({ who: v as Who })}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="group">Members of a group</SelectItem>
          <SelectItem value="role">Everyone with a role</SelectItem>
          <SelectItem value="member">Specific people</SelectItem>
          <SelectItem value="everyone">Everyone</SelectItem>
        </SelectContent>
      </Select>

      {draft.who === 'role' && (
        <div className="flex flex-wrap gap-1.5">
          {['member', 'admin', 'owner'].map((r) => (
            <Chip key={r} on={draft.roles.includes(r)} onClick={() => patch({ roles: toggle(draft.roles, r) })}>
              {r}
            </Chip>
          ))}
        </div>
      )}

      {draft.who === 'group' && (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-1.5">
            {[...new Set([...known, ...draft.groups])].map((g) => (
              <Chip key={g} on={draft.groups.includes(g)} onClick={() => patch({ groups: toggle(draft.groups, g) })}>
                {g}
              </Chip>
            ))}
          </div>
          <Input
            value={groupText}
            placeholder="Add a group (e.g. platform, or an SSO group name) and press Enter"
            onChange={(e) => setGroupText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addGroup();
              }
            }}
            onBlur={addGroup}
          />
        </div>
      )}

      {draft.who === 'member' && (
        <div className="flex flex-wrap gap-1.5">
          {(members.data ?? []).map((m) => (
            <Chip key={m.id} on={draft.members.includes(m.id)} onClick={() => patch({ members: toggle(draft.members, m.id) })}>
              {m.user.name ?? m.user.email ?? m.id}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
