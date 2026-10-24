import * as React from 'react';
import { CopyButton, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';

/** One NetBird client link from `mesh.people.connectInfo` (`downloads`). */
export interface ClientDownload {
  platform: string;
  label: string;
  url: string;
  /** Served by this cluster's controller (vs NetBird's release page / an app store). */
  mirrored: boolean;
  sha256?: string;
  size?: number;
}

const OS = [
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'phone', label: 'iPhone / Android' },
] as const;
type OsKey = (typeof OS)[number]['key'];

const isPhone = (p: string) => p === 'ios' || p === 'android';
/** Without a mirrored CLI: NetBird's own installer script (upstream). */
const UPSTREAM_LINUX = 'curl -fsSL https://pkgs.netbird.io/install.sh | sh';

export function Cmd({ value }: { value: string }): React.JSX.Element {
  return (
    <div className="bg-muted flex h-[38px] items-center gap-2 rounded-[10px] pr-1.5 pl-3">
      <code className="mono-data min-w-0 flex-1 truncate text-xs">{value}</code>
      <CopyButton value={value} className="size-7" />
    </div>
  );
}

function mb(size?: number): string {
  return size ? ` · ${Math.round(size / 1_000_000)} MB` : '';
}

/**
 * Step 1 of "Connect from your laptop": the NetBird app per platform. The
 * desktop installers come from this cluster's controller when it mirrors them
 * (no GitHub needed), else from NetBird's release page; phones use the stores.
 */
export function ClientDownloads({ downloads, cliInstall }: { downloads: ClientDownload[]; cliInstall: string | null }): React.JSX.Element {
  const [os, setOs] = React.useState<OsKey>('macos');
  const links = downloads.filter((d) => (os === 'phone' ? isPhone(d.platform) : d.platform.startsWith(`${os}-`)));
  const mirrored = downloads.some((d) => d.mirrored);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {OS.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={os === o.key}
            onClick={() => setOs(o.key)}
            className={cn(
              'pointer-coarse:min-h-11 h-7 rounded-lg border px-2.5 text-[12.5px] font-semibold',
              os === o.key ? 'bg-accent border-transparent' : 'text-muted-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {os === 'linux' && <Cmd value={cliInstall ?? UPSTREAM_LINUX} />}
      <ul className="grid gap-1.5">
        {links.map((l) => (
          <li key={l.platform}>
            <a
              href={l.url}
              {...(l.mirrored ? { download: '' } : { target: '_blank', rel: 'noreferrer' })}
              className="text-primary pointer-coarse:min-h-11 inline-flex items-center font-medium underline-offset-4 hover:underline"
            >
              {l.label}
            </a>
            <span className="text-muted-foreground text-xs">
              {isPhone(l.platform) ? ' · app store' : l.mirrored ? ` · from this cluster${mb(l.size)}` : ` · from NetBird${mb(l.size)}`}
            </span>
          </li>
        ))}
      </ul>
      {os !== 'phone' && links.length > 0 && (
        <Tech>
          {mirrored ? 'Served by this controller at /install/netbird/, checked against pinned sha256' : 'This controller mirrors no NetBird clients; links go to NetBird’s release page'}
        </Tech>
      )}
    </>
  );
}
