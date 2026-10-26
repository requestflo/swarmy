import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CodeView, SayHeader, Tech } from '@/components/calm';
import { TabBody } from '@/components/app-tabs/tab-body';
import { shortName, useStackServices } from '@/components/app-tabs/use-stack-services';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { SERVICE_ENV_PARSE } from '../env-paste-dialog';
import { useEnvPaste } from '../use-env-paste';
import { PasteChanges } from './paste-changes';
import { pasteCode } from './paste-code';
import { PasteFooter } from './paste-footer';
import { EnvLineEditor } from './env-line-editor';
import { PasteSamples } from './paste-samples-picker';
import { planPaste, SHARED } from './paste-target';
import { PasteTargetSelect, targetWords } from './paste-target-select';
import { usePasteEnvs } from './use-paste-envs';

const EMPTY: Record<string, string> = {};
const sel = 'border-border bg-background h-9 rounded-[8px] border px-2 font-mono text-[15px] font-semibold pointer-coarse:min-h-11';

/**
 * Paste a .env into one service (board EnvPaste): a numbered editor with the
 * parser's notes on their lines, the environment it goes to (one, or every
 * one as the shared value), what changes grouped (secrets detected · added ·
 * changed · removed · locked by swarmy.yaml), merge or Replace all, and one
 * rolling deploy per environment. The parser and diff are the shared ones
 * (`parseDotenv` / `diffEnv`); the target rules are `planPaste`.
 */
export function EnvPastePage({ stack, serviceId }: { stack: string; serviceId?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { services } = useStackServices(stack);
  const svc = services?.find((s) => s.id === serviceId) ?? services?.[0];
  const short = svc ? shortName(stack, svc.name) : '';
  const envs = usePasteEnvs(stack, short);
  const [picked, setPicked] = React.useState<string | null>(null);
  const names = envs.sides?.map((s) => s.environment) ?? [];
  const target = picked && (picked === SHARED ? names.length > 1 : names.includes(picked)) ? picked : envs.here;
  const shared = target === SHARED;
  const primary = envs.sides?.find((s) => s.environment === (shared ? 'production' : target)) ?? envs.sides?.[0];
  const detail = useQuery({ ...trpc.services.get.queryOptions({ id: primary?.serviceId ?? '' }), enabled: !!primary });
  const existing = React.useMemo(() => new Set(Object.keys(detail.data?.secretKeys ?? {})), [detail.data]);
  const st = useEnvPaste(primary?.current ?? EMPTY, SERVICE_ENV_PARSE, existing);
  const plans = envs.sides ? planPaste({ entries: st.entries, envs: envs.sides, target, mode: st.mode }) : [];

  const back = (
    <Button asChild variant="ghost" size="sm" className="w-fit pointer-coarse:min-h-11">
      <Link to="/stacks/$name/config" params={{ name: stack }}>
        <ArrowLeftIcon className="size-3.5" /> Variables
      </Link>
    </Button>
  );
  if (services && !svc) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-muted-foreground text-[13.5px]">{stack} isn't running any services, so there's nothing to paste into yet.</p>
      </div>
    );
  }
  const title = svc ? (
    <span className="flex flex-wrap items-baseline gap-x-2">
      Paste a .env into
      <select aria-label="Service" value={svc.id} className={sel} onChange={(e) => void navigate({ to: '/stacks/$name/config/paste', params: { name: stack }, search: { service: e.target.value }, replace: true })}>
        {services?.map((s) => (
          <option key={s.id} value={s.id}>{shortName(stack, s.name)}</option>
        ))}
      </select>
      {envs.gitApp && names.length > 0 ? <PasteTargetSelect environments={names} value={target} onChange={setPicked} /> : envs.here === 'preview' ? <em>preview</em> : null}
    </span>
  ) : null;

  return (
    <TabBody
      asideAt="code"
      header={
        <div className="flex flex-col gap-2">
          {back}
          {title ? <SayHeader size="md" title={title} lede="Comments, quotes, multi-line values and export are fine. Values that look like secrets are kept as secrets, and nothing changes until you apply." /> : <HeaderSkeleton />}
          {envs.gitApp && names.length > 0 ? <Tech>{targetWords(target, envs.here, names)}</Tech> : null}
          {envs.lockNote ? <p className={envs.blocked ? 'text-tone-warn text-[12.5px]' : 'text-muted-foreground text-[12.5px]'}>{envs.lockNote}{envs.blocked ? '. Nothing is applied until it can be read.' : '. Nothing is locked.'}</p> : null}
        </div>
      }
      aside={plans.length ? <CodeView title="This paste as code" tabs={pasteCode(short, plans, st.masked, st.pasted, st.mode === 'replace' && !shared)} source="dashboard" /> : undefined}
    >
      {!svc || !envs.sides || !detail.data ? (
        <CardSkeleton lines={6} />
      ) : (
        <>
          <PasteSamples onPick={st.setText} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <EnvLineEditor text={st.text} onChange={st.setText} warnings={st.warnings} />
            <PasteChanges st={st} plans={plans} short={short} existing={existing} shared={shared} />
          </div>
          <PasteFooter st={st} plans={plans} stack={stack} short={short} blocked={envs.blocked} />
        </>
      )}
    </TabBody>
  );
}
