import * as React from 'react';
import { Depth, Section, Tech } from '@/components/calm';
import type { HerokuImportView } from './heroku-types';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Names({ label, names }: { label: string; names: string[] }): React.JSX.Element | null {
  if (!names.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="calm-eyebrow">{label}</span>
      <span className="font-mono text-[12px] leading-relaxed break-words">{names.join('  ')}</span>
    </div>
  );
}

/**
 * The config vars: which go into swarmy.yaml as they are, which are sealed as
 * swarmy secrets (and whether Deploy holds their values), and which swarmy
 * fills in itself. Names only: values never reach the browser.
 */
export function HerokuPlanConfig({ view }: { view: HerokuImportView }): React.JSX.Element {
  const p = view.plan;
  const missing = p.secrets.filter((s) => !view.sealable.includes(s.name));
  const total = p.plainVars.length + p.secrets.length + p.bound.length;
  return (
    <Section title="Config vars" count={total}>
      <p className="text-[13.5px] leading-relaxed">
        {count(p.plainVars.length, 'setting')} {p.plainVars.length === 1 ? 'goes' : 'go'} into swarmy.yaml as {p.plainVars.length === 1 ? 'it is' : 'they are'}.{' '}
        {p.secrets.length ? (
          <>
            {count(p.secrets.length, 'value looks', 'values look')} secret, so {p.secrets.length === 1 ? 'it is' : 'they are'} sealed as swarmy secrets
            and never written to the file
            {missing.length ? <span className="text-tone-warn">; {count(missing.length, 'has', 'have')} no value from Heroku yet</span> : null}.{' '}
          </>
        ) : null}
        {p.bound.length ? <>swarmy fills in {p.bound.join(', ')} itself: Heroku’s values stay behind.</> : null}
      </p>
      <Depth at="controls">
        <div className="flex flex-col gap-3">
          <Names label="Sealed" names={p.secrets.map((s) => `${s.key} → ${s.name}`)} />
          <Names label="In swarmy.yaml" names={p.plainVars} />
          <Names label="Filled in by swarmy" names={p.bound} />
          <Tech>env: in swarmy.yaml · secrets as ${'{{ secrets.<name> }}'}</Tech>
        </div>
      </Depth>
    </Section>
  );
}
