import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { ErrorState } from '@/components/states';
import { RowsSkeleton } from '../tab-body';
import { shortName } from '../use-stack-services';
import { AddVariableBar } from './add-variable-bar';
import type { AddKind } from './use-add-variable';
import { useEnvTabs } from './use-env-tabs';
import { useVarTableData } from './use-var-table-data';
import { envText, rowsFor } from './var-table-model';
import { ScopeChips, VarToolbar, type VarView } from './var-toolbar';
import { VarRow } from './var-row';
import { variablesCode } from './variables-model';
import { PasteEnvButton } from './paste-env-button';
import { SecretRevealBanner, type RevealedSecret } from '@/components/secretsmgr/secret-reveal-banner';

/**
 * Variables & secrets as one table (board AppVariables): environment tabs
 * for a git app, service scope chips, plain values · connections · secret
 * variables · secret families in one list, a Table / .env / swarmy.yaml
 * switch, and Add (Plain / Secret / Reference) underneath.
 */
export function VariablesSection({ stack, preset }: { stack: string; preset?: { kind: AddKind; key: string; n: number } }): React.JSX.Element {
  const { tabs } = useEnvTabs(stack);
  const [envKey, setEnvKey] = React.useState<string | null>(null);
  const tab = tabs.find((t) => t.key === envKey) ?? tabs.find((t) => t.stack === stack);
  const view = tab?.stack ?? stack;
  const data = useVarTableData(view);
  const [scope, setScope] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<VarView>('table');
  const [open, setOpen] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<RevealedSecret | null>(null);
  React.useEffect(() => setScope(null), [view]);

  const services = data.services ?? [];
  const families = data.families ?? [];
  const scoped = services.find((s) => s.id === scope) ?? null;
  const rows = data.ready ? rowsFor(view, services, data.vars, families, scoped?.id ?? null) : [];
  const chips = data.ready
    ? [
        { id: null, label: 'All services', count: rowsFor(view, services, data.vars, families, null).length },
        ...services.map((s) => ({ id: s.id, label: shortName(view, s.name), count: rowsFor(view, services, data.vars, families, s.id).length })),
      ]
    : [];
  const secrets = rows.filter((r) => r.kind === 'family' || r.kind === 'secretVar').length;
  const raw = mode === 'env' ? envText(rows, scoped ? shortName(view, scoped.name) : 'all services') : mode === 'yaml' ? (variablesCode(view, scoped ? [scoped] : services, families)[0]?.code ?? '') : '';
  const pasteTo = scoped ?? services[0];

  return (
    <>
      {revealed ? <SecretRevealBanner revealed={revealed} onDismiss={() => setRevealed(null)} /> : null}
      <Section title="Variables & secrets" count={data.ready ? rows.length : undefined} hint="connections fill themselves in · secrets are files, never in git" flush>
        <VarToolbar
          tabs={tabs}
          env={tab?.key}
          onEnv={setEnvKey}
          view={mode}
          onView={setMode}
          paste={pasteTo ? <PasteEnvButton serviceId={pasteTo.id} label={shortName(view, pasteTo.name)} /> : null}
        />
        {tab?.note ? <p className="text-muted-foreground pb-2 text-xs">{tab.note}</p> : null}
        {data.ready && services.length > 1 ? (
          <ScopeChips options={chips} value={scope} onChange={setScope} note={`${rows.length - secrets} variables · ${secrets} secrets`} />
        ) : null}
        {data.error && !data.ready ? (
          <ErrorState title="Couldn't load this app's settings" error={data.error} />
        ) : !data.ready ? (
          <RowsSkeleton />
        ) : services.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">{view} isn't running anything right now, so there is nothing to read.</p>
        ) : mode !== 'table' ? (
          <div className="relative pb-3">
            <CopyButton value={raw} className="absolute top-2 right-2 size-8" />
            <pre className="calm-code max-h-[26rem] overflow-auto rounded-xl p-3 font-mono text-[12px] leading-relaxed">{raw}</pre>
            <p className="text-muted-foreground pt-1.5 text-xs">Read only · secrets stay masked</p>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">No variables yet. Add one below, or paste a whole .env.</p>
        ) : (
          <ul aria-label="Variables and secrets" className="flex flex-col">
            {rows.map((r) => (
              <VarRow key={`${r.kind}:${r.key}`} row={r} stack={view} total={scoped ? 1 : services.length} expanded={open === r.key} onToggle={() => setOpen((o) => (o === r.key ? null : r.key))} />
            ))}
          </ul>
        )}
        {data.ready && services.length > 0 ? (
          <AddVariableBar stack={view} services={services} scopeId={scoped?.id ?? null} preset={preset} onSecret={setRevealed} />
        ) : null}
      </Section>
    </>
  );
}
