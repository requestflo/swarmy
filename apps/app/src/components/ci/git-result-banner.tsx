import * as React from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2Icon, HourglassIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { KIND_LABEL, type GitConnectionKind } from './git-types';

/** The `?git=` result the controller's provider callbacks redirect back with. */
export interface GitResultSearch {
  git?: 'connected' | 'error' | 'requested';
  kind?: GitConnectionKind;
  connection?: string;
  message?: string;
}

export function parseGitResultSearch(search: Record<string, unknown>): GitResultSearch {
  const out: GitResultSearch = {};
  if (search.git === 'connected' || search.git === 'error' || search.git === 'requested')
    out.git = search.git;
  if (typeof search.kind === 'string' && search.kind in KIND_LABEL)
    out.kind = search.kind as GitConnectionKind;
  if (typeof search.connection === 'string' && /^[\w-]{1,64}$/.test(search.connection))
    out.connection = search.connection;
  if (typeof search.message === 'string') out.message = search.message.slice(0, 200);
  return out;
}

interface GitResultBannerProps {
  /** Open the New-app wizard on the just-connected provider. */
  onStart: (connectionId?: string) => void;
}

/** Plain-words banner for the provider round-trip; clears the query so a refresh doesn't repeat it. */
export function GitResultBanner({ onStart }: GitResultBannerProps): React.JSX.Element | null {
  const search = useSearch({ strict: false }) as GitResultSearch;
  const navigate = useNavigate();
  const [result, setResult] = React.useState<GitResultSearch | null>(null);

  React.useEffect(() => {
    if (!search.git) return;
    setResult({
      git: search.git,
      kind: search.kind,
      connection: search.connection,
      message: search.message,
    });
    void navigate({ to: '.', search: {}, replace: true });
  }, [search.git, search.kind, search.connection, search.message, navigate]);

  if (!result?.git) return null;
  const name = result.kind ? KIND_LABEL[result.kind] : 'Your git provider';
  const view =
    result.git === 'connected'
      ? {
          tone: 'text-tone-ok',
          Icon: CheckCircle2Icon,
          text: `${name} is connected. Pick a repo and ship it.`,
        }
      : result.git === 'requested'
        ? {
            tone: 'text-tone-info',
            Icon: HourglassIcon,
            text: 'Install requested. An owner of that GitHub org needs to approve swarmy — it shows up here once they do.',
          }
        : {
            tone: 'text-tone-bad',
            Icon: TriangleAlertIcon,
            text: `That didn’t connect. ${result.message ?? 'Try again from Connections.'}`,
          };

  return (
    <div role="status" className="calm-card mb-6 flex flex-wrap items-center gap-3 px-5 py-4">
      <view.Icon className={cn('size-5 shrink-0', view.tone)} />
      <p className="min-w-0 flex-1 text-sm font-medium">{view.text}</p>
      {result.git === 'connected' ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onStart(result.connection);
            setResult(null);
          }}
        >
          Pick a repo
        </Button>
      ) : null}
      <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => setResult(null)}>
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
