import * as React from 'react';
import { AlreadyOn, Depth, SayHeader } from '@/components/calm';
import { useDebouncedValue } from '@/components/ci/use-debounced-value';
import { GroupedErrors } from './grouped-errors';
import { rangePreset, type LogRangePreset } from './logs-shared';
import { ObsCode } from './obs-code';
import { INITIAL_NAV, navReducer } from './stream-keys';
import { StreamList } from './stream-list';
import { byLevel, errorParts, fingerprint, groupErrors, levelCounts, levelOf, lineKey, type LevelFilter } from './stream-model';
import { StreamShortcuts } from './stream-shortcuts';
import { streamHeadline } from './stream-summary';
import { StreamToolbar } from './stream-toolbar';
import { useLogStream } from './use-log-stream';
import { useStackServiceNames } from './use-stack-services';
import { useStreamKeys } from './use-stream-keys';

/**
 * Logs & traces with telemetry on (Logs board): the sentence from the lines
 * on screen, the toolbar, the live tail with inline trace waterfalls, and the
 * grouped-errors aside. `children` (the health block) renders under the
 * stream from Controls.
 */
export function LogsView({ stack, retentionDays, children }: { stack: string; retentionDays: number | undefined; children: React.ReactNode }): React.JSX.Element {
  const [level, setLevel] = React.useState<LevelFilter>('all');
  const [part, setPart] = React.useState('');
  const [range, setRange] = React.useState<LogRangePreset>('15m');
  const [search, setSearch] = React.useState('');
  const [group, setGroup] = React.useState<string | null>(null);
  const [nav, dispatch] = React.useReducer(navReducer, INITIAL_NAV);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const { names } = useStackServiceNames(stack);
  const debounced = useDebouncedValue(search, 250);
  const feed = useLogStream({ stack, range, part: part || undefined, search: debounced, enabled: true, paused: nav.paused });

  const counts = React.useMemo(() => levelCounts(feed.rows), [feed.rows]);
  const groups = React.useMemo(() => groupErrors(feed.rows), [feed.rows]);
  const parts = React.useMemo(() => errorParts(feed.rows), [feed.rows]);
  const visible = React.useMemo(() => {
    const rows = byLevel(feed.rows, level).filter((r) => !group || `${r.service_name}|${fingerprint(r.body)}` === group);
    return rows.slice().reverse();
  }, [feed.rows, level, group]);
  const lines = React.useMemo(() => visible.map((r) => ({ key: lineKey(r), error: levelOf(r.severity_number) === 'error' })), [visible]);
  useStreamKeys(dispatch, lines, searchRef);

  const preset = rangePreset(range);
  const head = streamHeadline(stack, counts, parts, preset.words, feed.capped);
  const pickGroup = (key: string | null): void => {
    setGroup(key);
    if (key) setLevel('all');
  };

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader size="md" title={feed.isPending ? `Reading ${stack}’s logs…` : head.title} lede={feed.isPending ? undefined : head.lede} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-label="Log stream" className="calm-card flex min-w-0 flex-col gap-3 pt-3">
            <div className="px-3">
              <StreamToolbar
                level={level} counts={counts} onLevel={setLevel}
                parts={names} part={part} onPart={setPart}
                search={search} onSearch={setSearch} searchRef={searchRef}
                range={range} onRange={setRange}
                paused={nav.paused} onTogglePause={() => dispatch({ kind: 'paused', paused: !nav.paused })}
                group={group} onClearGroup={() => setGroup(null)}
              />
            </div>
            <StreamList rows={visible} nav={nav} dispatch={dispatch} fresh={feed.fresh} capped={feed.capped}
              pending={feed.isPending} unreachable={feed.status === 'unreachable'} filtered={level !== 'all' || !!group || !!part || !!debounced} />
          </section>
          <Depth at="controls">{children}</Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-5">
          <Depth at="code">
            <ObsCode stack={stack} enabled part={part} focus={parts[0]} />
          </Depth>
          <GroupedErrors stack={stack} groups={groups} active={group} onPick={pickGroup} />
          <Depth at="controls">
            <StreamShortcuts />
          </Depth>
          <AlreadyOn
            title="Also running here"
            items={[
              { what: 'Traces', detail: 'every request, end to end' },
              { what: 'Logs', detail: 'every part, searchable' },
              { what: 'Kept', detail: retentionDays ? `${retentionDays} days, then dropped` : 'on the store’s schedule' },
            ]}
          />
        </aside>
      </div>
    </div>
  );
}
