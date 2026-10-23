import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView, useDepth } from '@/components/calm';
import { caddyfileOf, siteBlock } from '@/components/ingress/caddyfile-text';
import { useTRPC } from '@/integrations/trpc';

/**
 * The raw Caddyfile swarmy renders from your domains (`ingress.previewConfig`),
 * read-only, at Code. With an address picked, its own site block comes first.
 */
export function NetworkCaddyCode({ selected, caddy }: { selected: string | null; caddy: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const atCode = useDepth().atLeast('code');
  const preview = useQuery({ ...trpc.ingress.previewConfig.queryOptions({}), enabled: atCode && caddy });
  if (!caddy) return null;
  const text = caddyfileOf(preview.data);
  const whole = text ?? (preview.isPending ? '# rendering…' : '# swarmy writes no Caddyfile right now');
  const block = text && selected ? siteBlock(text, selected) : null;
  const tabs = [
    ...(selected ? [{ label: selected, code: block ?? `# ${selected} is not in the rendered file yet: it is withheld until its DNS verifies` }] : []),
    { label: 'Whole file', code: whole },
  ];
  return (
    <CodeView
      key={selected ?? '~'}
      title="The Caddyfile swarmy writes"
      tabs={tabs}
      source="readonly"
      note="Read only. swarmy writes this from your domains; change them on this page or each app's Domains tab, not here."
    />
  );
}
