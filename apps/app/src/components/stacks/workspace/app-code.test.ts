import { describe, expect, test } from 'bun:test';
import type { AppItem } from '@/components/apps/use-apps';
import { appCodeTabs } from './app-code';
import type { ConfigFileView } from '../source/use-config-file';

const app = { name: 'storefront', stat: { services: [], serviceCount: 0 } } as unknown as AppItem;
const yaml: ConfigFileView = {
  repoId: 'r1', environment: 'production', path: 'swarmy.yaml', sha: 'abcdef1234567', text: 'version: 1\napp: storefront\n',
  fetchedAt: '2026-11-11T00:00:00Z', lastWebhookAt: null, lastPollAt: null, previewDomain: null,
};

describe('appCodeTabs', () => {
  test('a git app leads with the swarmy.yaml it deploys from, then the live spec', () => {
    const tabs = appCodeTabs(app, 'stk_1', yaml);
    expect(tabs.map((t) => t.label)).toEqual(['swarmy.yaml', 'compose', 'CLI', 'REST']);
    expect(tabs[0]?.code).toBe('# swarmy.yaml @ abcdef1 · what storefront deploys from (edit it on Source)\nversion: 1\napp: storefront\n');
  });
  test('an app with no repo (or no file at that commit) starts at the live spec', () => {
    expect(appCodeTabs(app, null).map((t) => t.label)).toEqual(['compose', 'CLI']);
    expect(appCodeTabs(app, null, { ...yaml, text: null }).map((t) => t.label)).toEqual(['compose', 'CLI']);
  });
});
