import * as React from 'react';
import { CodeView } from '@/components/calm';
import { installOneLiner } from './install-command-panel';
import type { NodeRoleChoice } from './node-role-picker';
import type { JoinLink } from './use-join-link';

/** Code depth for Add a server: the install line spelled out, and the raw join token. */
export function AddServerCode({
  link,
  role,
  labels,
}: {
  link: JoinLink | null;
  role: NodeRoleChoice;
  labels: string;
}): React.JSX.Element | null {
  if (!link) return null;
  const line = installOneLiner(link.token, labels, role, link.mesh, link.target);
  // `curl … | ENV=… sh -s -- --controller <base>`, one piece per line.
  const [fetch = '', pipe = ''] = line.split(' | ');
  const shAt = pipe.indexOf(' sh -s -- ');
  const envs = (shAt >= 0 ? pipe.slice(0, shAt) : pipe).split(' ').filter(Boolean);
  const tail = shAt >= 0 ? pipe.slice(shAt + 1) : '';
  const install = [
    '# on the new server (as root, or with sudo)',
    `${fetch} \\`,
    ...envs.map((e, i) => `  ${i === 0 ? '| ' : '  '}${e} \\`),
    `    ${tail}`,
  ].join('\n');
  const token = [
    '# the join token inside the line: single use, treat it like a password',
    `SWARMY_JOIN_TOKEN=${link.token}`,
    `# expires ${link.expiresAt.toISOString()}`,
    ...(link.mesh ? [`SWARMY_MESH_SETUP_KEY=${link.mesh.setupKey}`] : []),
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'install', code: install },
        { label: 'join token', code: token },
      ]}
      source="readonly"
      note="The same line as above, spelled out. Revoke unused links in Settings → Join tokens."
    />
  );
}
