import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth, Section } from '@/components/calm';
import { SkeletonBody } from '@/components/states';
import { RowPage } from '@/components/rowpage/row-page';
import { TwoFactorCard } from '@/components/security/two-factor-card';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { PreferencesSection } from './preferences-section';
import { SettingsSections } from './settings-sections';
import { TokensTab } from './tokens-tab';
import { workspaceCode } from './workspace-code';
import { WorkspaceSection } from './workspace-section';

const SECTIONS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'security', label: 'Your security' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'join', label: 'Server join tokens' },
];

/** Settings → Workspace: the workspace, your own sign-in security, your preferences. */
export function WorkspacePage(): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const me = useQuery(trpc.org.whoami.queryOptions());
  const sec = useQuery(trpc.security.me.queryOptions());
  const members = useQuery(trpc.org.members.queryOptions());
  const estate = useEstateSummary();
  const o = org.data;
  const needs2fa = sec.data ? !sec.data.enrolled && sec.data.hasPassword : false;

  const title = !o ? 'Workspace.' : (
    <>
      {o.name}. <em>You’re {o.role === 'admin' ? 'an admin' : `the ${o.role}`}.</em>
    </>
  );
  const lede = o && members.data && estate.data
    ? `${members.data.length} ${members.data.length === 1 ? 'person' : 'people'} and ${estate.data.nodes.total} servers. ${sec.data?.enrolled ? 'Your password sign-in asks for a code.' : 'Two-factor is off for your password sign-in; one scan turns it on.'}`
    : undefined;

  return (
    <RowPage title={title} description={lede}>
      {o ? <CodeView title="You, as code" tabs={workspaceCode(o, me.data?.email ?? null)} source="readonly" /> : null}
      <SettingsSections sections={SECTIONS}>
        {o ? <WorkspaceSection org={o} people={members.data?.length} servers={estate.data?.nodes.total} /> : <SkeletonBody variant="form" />}
        <div id="security" className="scroll-mt-6">
          <TwoFactorCard primary={needs2fa} />
        </div>
        <PreferencesSection />
        <Section id="join" title="Server join tokens" hint="how a new server proves it belongs here">
          <p className="text-muted-foreground text-sm">Adding a server makes a token for you. Mint or revoke them by hand from Controls.</p>
          <Depth at="controls">
            <TokensTab />
          </Depth>
        </Section>
      </SettingsSections>
    </RowPage>
  );
}
