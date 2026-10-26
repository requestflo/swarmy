import * as React from 'react';
import { Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { Segmented } from '@/components/service-settings/settings-row';
import { SIZE_OPTIONS, keepOptions, sleepOptions, type BranchesChoice, type DataChoice, type RulesDraft } from './preview-rules-edit';

const BRANCHES: Array<{ value: BranchesChoice; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'prs', label: 'Pull requests' },
  { value: 'branches', label: 'PRs + branches' },
];
const DATA: Array<{ value: DataChoice; label: string }> = [
  { value: 'empty', label: 'Empty' },
  { value: 'copy', label: 'Copy of production' },
];

function Row({ label, tech, children }: { label: string; tech: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      <Tech>{tech}</Tech>
    </div>
  );
}

/** The preview rules as choices (board 68): who gets one, where, how long, sleep, data, size. */
export function PreviewRulesFields({ d, set }: { d: RulesDraft; set: (p: Partial<RulesDraft>) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Row label="Who gets a preview" tech="previews.enabled · previews.branches">
        <Segmented label="Who gets a preview" options={BRANCHES} value={d.branches} onChange={(branches) => set({ branches })} />
        {d.branches === 'branches' ? (
          <Input aria-label="Branch patterns" value={d.patterns} onChange={(e) => set({ patterns: e.target.value })} placeholder="feature/*, release/**" className="h-9 max-w-sm font-mono text-[12.5px]" />
        ) : null}
      </Row>
      <Row label="Address" tech="previews.base_domain — each preview gets <branch or pr-N>.<this>">
        <Input aria-label="Preview domain" value={d.baseDomain} onChange={(e) => set({ baseDomain: e.target.value })} placeholder="preview.example.com" className="h-9 max-w-sm font-mono text-[12.5px]" />
      </Row>
      <Row label="Keep for" tech="previews.ttl — counted from the last push">
        <Segmented label="Keep for" options={keepOptions(d.keep)} value={d.keep} onChange={(keep) => set({ keep })} />
      </Row>
      <Row label="Sleeps after idle" tech="previews.sleep_after — wakes on the next visit">
        <Segmented label="Sleeps after idle" options={sleepOptions(d.sleep)} value={d.sleep} onChange={(sleep) => set({ sleep })} />
      </Row>
      <Row label="New data" tech={d.shared ? 'previews.resources: shared' : 'previews.data — a copy of the latest backup, destroyed with the preview'}>
        {d.shared ? (
          <span className="text-muted-foreground text-[13px]">Shares production’s data — change previews.resources in swarmy.yaml to give each its own.</span>
        ) : (
          <Segmented label="New data" options={DATA} value={d.data} onChange={(data) => set({ data })} />
        )}
        {!d.shared && d.data === 'copy' ? (
          <Input aria-label="Scrub file" value={d.scrub} onChange={(e) => set({ scrub: e.target.value })} placeholder="db/scrub.sql — masks personal data" className="h-9 max-w-sm font-mono text-[12.5px]" />
        ) : null}
      </Row>
      <Row label="Largest a service may get" tech="previews.size — a preview service never gets more">
        <Segmented label="Largest a service may get" options={SIZE_OPTIONS} value={d.size} onChange={(size) => set({ size })} />
      </Row>
    </div>
  );
}
