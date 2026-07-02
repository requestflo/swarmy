import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PreviewBranchForm } from './previews-branch-form';

interface RepoRef {
  id: string;
  url: string;
}

function repoLabel(url: string): string {
  return url.replace(/\.git$/, '').split('/').slice(-2).join('/');
}

/** Per-repo preview settings: enable, base domain, TTL, teardown-on-close. */
export function PreviewsSettingsCard({ repos }: { repos: RepoRef[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [repoId, setRepoId] = React.useState<string>(repos[0]?.id ?? '');
  React.useEffect(() => {
    if (repos.length > 0 && !repos.some((r) => r.id === repoId)) setRepoId(repos[0]!.id);
  }, [repos, repoId]);

  const settings = useQuery({
    ...trpc.previews.getSettings.queryOptions({ repoId }),
    enabled: repoId.length > 0,
  });

  const [enabled, setEnabled] = React.useState(false);
  const [baseDomain, setBaseDomain] = React.useState('');
  const [ttlHours, setTtlHours] = React.useState(72);
  const [teardownOnClose, setTeardownOnClose] = React.useState(true);
  React.useEffect(() => {
    if (settings.data) {
      setEnabled(settings.data.enabled);
      setBaseDomain(settings.data.baseDomain);
      setTtlHours(settings.data.ttlHours);
      setTeardownOnClose(settings.data.teardownOnClose);
    }
  }, [settings.data]);

  const save = useMutation(
    trpc.previews.setSettings.mutationOptions({
      onSuccess: () => {
        toast.success('Preview settings saved');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (repos.length === 0) {
    return (
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Preview settings</CardTitle>
          <CardDescription>Link a repo first — previews build from your PRs.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Preview settings</CardTitle>
        <CardDescription>Per repo: turn previews on, pick where they publish, set how long they live.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="mono-label">Repo</Label>
          <Select value={repoId} onValueChange={setRepoId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {repoLabel(r.url)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="mono-label">Previews enabled</Label>
            <p className="text-muted-foreground text-xs">PR opened → deploy; PR updated → redeploy.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Base domain</Label>
          <Input
            placeholder="preview.example.com"
            value={baseDomain}
            onChange={(e) => setBaseDomain(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Previews publish at <span className="mono-data">pr-&lt;N&gt;.{baseDomain || 'preview.example.com'}</span>. Leave
            empty for no public URL.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">TTL (hours)</Label>
          <Input
            type="number"
            min={0}
            max={720}
            value={ttlHours}
            onChange={(e) => setTtlHours(Math.max(0, Math.min(720, Number(e.target.value) || 0)))}
          />
          <p className="text-muted-foreground text-xs">Idle previews auto-destroy after this. 0 = keep forever.</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="mono-label">Tear down on close</Label>
          <Switch checked={teardownOnClose} onCheckedChange={setTeardownOnClose} />
        </div>
        <Button
          className="justify-self-start rounded-full font-bold"
          disabled={save.isPending || settings.isLoading}
          onClick={() => save.mutate({ repoId, enabled, baseDomain, ttlHours, teardownOnClose })}
        >
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        <Separator />
        <PreviewBranchForm repoId={repoId} />
      </CardContent>
    </Card>
  );
}
