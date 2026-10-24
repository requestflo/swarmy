import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CodeView, Say, SayHeader } from '@/components/calm';
import { CardSkeleton, ErrorState, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ConvertChanges, ConvertGaps } from './convert-gaps';
import { ConvertNext } from './convert-next';
import { ConvertToolbar } from './convert-toolbar';
import { graphWords, LiveGraph } from './live-graph';
import { convertCodeTabs } from './source-code';
import { useYamlDraft } from './use-yaml-draft';
import { YamlEditor } from './yaml-editor';

type View = NonNullable<ReturnType<typeof useConvert>['data']>;

/** `apps.convertToConfig`: generated and checked on the controller. A compose doesn't change under you, so it isn't polled. */
function useConvert(stack: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.apps.convertToConfig.queryOptions({ stack }), staleTime: 60_000, retry: false });
}

const noop = (): void => undefined;
const noFix = (): null => null;

function Back({ stack }: { stack: string }): React.JSX.Element {
  return (
    <Button asChild variant="outline" className="pointer-coarse:min-h-11">
      <Link to="/stacks/$name/source" params={{ name: stack }}>
        Back to the live spec
      </Link>
    </Button>
  );
}

/**
 * Convert to swarmy.yaml (epic-git-apps phase 5) for an app deployed from
 * compose: the generated file in the editor view, read-only, with the
 * parser's verdict, what it builds (toDesired, drawn live), what didn't
 * translate and why, Copy / Download, and the honest next step.
 */
export function ConvertView({ stack }: { stack: string }): React.JSX.Element {
  const q = useConvert(stack);
  if (q.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <HeaderSkeleton />
        <CardSkeleton lines={14} />
      </div>
    );
  }
  if (q.isError) return <ErrorState title={`Couldn’t convert ${stack}’s compose.`} error={q.error} retry={() => void q.refetch()} />;
  if (!q.data.yaml) {
    return (
      <div className="flex flex-col gap-5 pb-24 lg:pb-12">
        <SayHeader size="md" title={<>There’s nothing to convert yet.</>} lede={q.data.reason ?? undefined} actions={<Back stack={stack} />} />
      </div>
    );
  }
  return <ConvertFile stack={stack} view={q.data} yaml={q.data.yaml} />;
}

function ConvertFile({ stack, view, yaml }: { stack: string; view: View; yaml: string }): React.JSX.Element {
  const d = useYamlDraft(yaml);
  const lost = view.untranslated.filter((g) => !g.handled).length;
  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-12">
      <SayHeader
        size="md"
        title={
          <>
            Here’s {stack} as swarmy.yaml.{' '}
            {lost ? (
              <Say tone="warn">{lost === 1 ? 'One setting' : `${lost} settings`} didn’t translate.</Say>
            ) : (
              <em>Everything translated.</em>
            )}
          </>
        }
        lede={`${d.graph ? graphWords(d.graph) : 'The file'}, from the compose swarmy deployed ${stack} from. Checked with the same parser swarmy runs on every push.`}
        actions={<Back stack={stack} />}
      />
      <ConvertNext stack={stack} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ConvertToolbar path={view.path} yaml={yaml} issues={d.parsed.issues} />
          <YamlEditor readOnly value={d.text} onChange={noop} issues={d.parsed.issues} marks={d.marks} request={null} fixOf={noFix} />
          <ConvertGaps gaps={view.untranslated} />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <CodeView tabs={convertCodeTabs(stack)} note="The file lives in your repo once you commit it. Nothing here writes to git." />
          <LiveGraph graph={d.graph} diff={d.diff} dirty={false} old={d.graphIsOld} onUndo={noop} hint="drawn from the file" />
          <ConvertChanges changes={view.changes} />
        </aside>
      </div>
    </div>
  );
}
