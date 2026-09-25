import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CopyButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const OS = {
  mac: { label: 'macOS', install: 'brew install netbirdio/tap/netbird-ui' },
  win: { label: 'Windows', install: 'winget install NetBird.NetBird' },
  linux: { label: 'Linux', install: 'curl -fsSL https://pkgs.netbird.io/install.sh | sh' },
  ios: { label: 'iPhone / Android', install: 'App Store or Google Play: “NetBird”' },
} as const;
type OsKey = keyof typeof OS;

const TTLS = [
  { label: '1 hour', sec: 3600 },
  { label: '8 hours', sec: 8 * 3600 },
  { label: '1 day', sec: 86400 },
  { label: '1 week', sec: 7 * 86400 },
  { label: 'No expiry', sec: 0 },
];

function Step({ n, on, title, children }: { n: number; on?: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'mono-data inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11.5px] font-semibold',
          on ? 'bg-primary text-primary-foreground border-transparent' : 'text-muted-foreground',
        )}
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

function Cmd({ value }: { value: string }) {
  return (
    <div className="bg-muted flex h-[38px] items-center gap-2 rounded-[10px] pr-1.5 pl-3">
      <code className="mono-data min-w-0 flex-1 truncate text-xs">{value}</code>
      <CopyButton value={value} className="size-7" />
    </div>
  );
}

/**
 * App → Network → "Connect from your laptop" (plan §3.4, design board
 * RLaptop): install NetBird, sign in with swarmy (a per-cluster profile, so a
 * work NetBird account is never clobbered), then the addresses you can reach —
 * or, without a grant, who can give you one. Below: who's connected to this
 * app right now, and the personal grants (admins).
 */
export function ConnectFromLaptop({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const info = useQuery(trpc.mesh.people.connectInfo.queryOptions({ stack }));
  const connected = useQuery({ ...trpc.mesh.people.connected.queryOptions({ stack }), refetchInterval: 10_000 });
  const grants = useQuery(trpc.mesh.people.grants.queryOptions({ stack }));
  const members = useQuery(trpc.members.list.queryOptions());
  const [os, setOs] = React.useState<OsKey>('mac');
  const [who, setWho] = React.useState('');
  const [ttl, setTtl] = React.useState('28800');
  const invalidate = () => void qc.invalidateQueries();
  const onError = (e: { message: string }) => toast.error(e.message);
  const grant = useMutation(
    trpc.mesh.people.grant.mutationOptions({
      onSuccess: () => {
        toast.success('Access granted — it reaches their laptop within seconds');
        setWho('');
        invalidate();
      },
      onError,
    }),
  );
  const revoke = useMutation(trpc.mesh.people.revoke.mutationOptions({ onSuccess: () => (toast.success('Access removed'), invalidate()), onError }));
  const revokeDevice = useMutation(
    trpc.mesh.people.revokeDevice.mutationOptions({ onSuccess: () => (toast.success('Device disconnected'), invalidate()), onError }),
  );

  const d = info.data;
  const memberName = (userId: string) => {
    const m = (members.data ?? []).find((x: { user: { id: string } }) => x.user.id === userId) as
      | { user: { name: string | null; email: string | null } }
      | undefined;
    return m?.user.name || m?.user.email || userId;
  };

  return (
    <section className="space-y-4">
      <h2 className="headline text-xl">
        Connect from your <em>laptop</em>
      </h2>
      {info.isPending ? (
        <div className="shimmer-line h-24 rounded-xl" />
      ) : !d?.available ? (
        <p className="text-muted-foreground text-sm">{d?.reason ?? 'Not available on this cluster.'}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="calm-card">
            <CardContent className="grid gap-5 p-6 text-sm">
              <p className="text-muted-foreground">
                Databases and admin pages never face the internet. Sign in from your laptop and you reach exactly the ones your role
                allows here — nothing else.
              </p>
              <Step n={1} on title="Install the NetBird app">
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(OS) as OsKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setOs(k)}
                      className={cn(
                        'h-7 rounded-lg border px-2.5 text-[12.5px] font-semibold',
                        os === k ? 'bg-accent border-transparent' : 'text-muted-foreground',
                      )}
                    >
                      {OS[k].label}
                    </button>
                  ))}
                </div>
                <Cmd value={OS[os].install} />
              </Step>
              <Step n={2} title="Sign in with swarmy">
                <p className="text-muted-foreground">
                  A browser opens swarmy's own sign-in (SSO and passkeys work). Its own profile keeps any other NetBird you use apart;
                  switching profiles disconnects the other one.
                </p>
                {d.commands && (
                  <>
                    <Cmd value={d.commands.add} />
                    <Cmd value={d.commands.up} />
                  </>
                )}
              </Step>
              <Step n={3} title="Use the addresses on the right">
                <p className="text-muted-foreground">
                  Your tools connect to them as if they were on your desk. You sign in again after {d.loginExpiryHours} h.
                </p>
              </Step>
            </CardContent>
          </Card>

          <Card className="calm-card">
            <CardContent className="divide-border grid divide-y p-0 text-sm">
              <div className="px-6 py-4">
                <p className="font-medium">{d.allowed ? 'What you can reach' : "You can't connect to this app yet"}</p>
                <p className="text-muted-foreground">
                  {d.allowed
                    ? d.via.map((v: { detail: string; expiresAt?: string | null }) => v.detail + (v.expiresAt ? ` until ${new Date(v.expiresAt).toLocaleString()}` : '')).join(' · ')
                    : `Ask ${d.grantors.map((g: { name: string | null; email: string | null }) => g.name || g.email).filter(Boolean).join(', ') || 'an admin'} for access.`}
                </p>
              </div>
              {(d.allowed ? d.services : []).map((s: { name: string; fqdn: string; ports: { port: number; proto: string }[]; hint: string | null }) => (
                <div key={s.name} className="grid gap-1.5 px-6 py-3">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{s.name}</span>
                    <span className="mono-data rounded-md bg-violet-500/10 px-2 py-0.5 text-xs text-violet-500">
                      {s.fqdn}:{s.ports.map((p) => p.port).join(',')}
                    </span>
                    <CopyButton value={`${s.fqdn}:${s.ports[0]?.port ?? ''}`} className="ml-auto size-7" />
                  </div>
                  {s.hint && <code className="mono-data text-muted-foreground text-xs">{s.hint}</code>}
                </div>
              ))}
              {d.allowed && d.services.length === 0 && (
                <p className="text-muted-foreground px-6 py-3">
                  This app declares no ports people may reach. Add a label{' '}
                  <span className="mono-data">swarmy.mesh.ports=5432</span> to a service.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {d?.available && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="calm-card">
            <CardContent className="divide-border grid divide-y p-0 text-sm">
              <div className="px-6 py-4">
                <p className="font-medium">Connected people</p>
                <p className="text-muted-foreground">Devices that can reach this app right now.</p>
              </div>
              {(connected.data ?? []).length === 0 && <p className="text-muted-foreground px-6 py-3">Nobody yet.</p>}
              {(connected.data ?? []).map(
                (p: { peerId: string; name: string; email: string; device: string; connected: boolean; meshIp: string; os?: string; version?: string; lastSeen?: string; loginExpired: boolean }) => (
                  <div key={p.peerId} className="flex items-center gap-3 px-6 py-3">
                    <span className={cn('size-2 shrink-0 rounded-full', p.connected ? 'bg-status-online' : 'bg-muted-foreground')} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {p.device} <span className="text-muted-foreground font-normal">· {p.name || p.email}</span>
                      </p>
                      <p className="text-muted-foreground mono-data truncate text-xs">
                        {p.connected ? 'online' : p.loginExpired ? 'signed out (login expired)' : `last seen ${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : '—'}`} · {p.meshIp}
                        {p.os ? ` · ${p.os}` : ''}
                        {p.version ? ` · netbird ${p.version}` : ''}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => revokeDevice.mutate({ peerId: p.peerId })}>
                      Disconnect
                    </Button>
                  </div>
                ),
              )}
            </CardContent>
          </Card>

          <Card className="calm-card">
            <CardContent className="divide-border grid divide-y p-0 text-sm">
              <div className="px-6 py-4">
                <p className="font-medium">Personal access</p>
                <p className="text-muted-foreground">
                  On top of the rules: one person, this app, for a while. Removing it cuts them off within seconds.
                </p>
              </div>
              {(grants.data ?? []).map((g: { id: string; userId: string; service: string | null; port: number | null; expiresAt: string | null }) => (
                <div key={g.id} className="flex items-center gap-3 px-6 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{memberName(g.userId)}</p>
                    <p className="text-muted-foreground text-xs">
                      {g.service ? g.service : 'every service'}
                      {g.port ? ` · port ${g.port}` : ''} · {g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleString()}` : 'no expiry'}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => revoke.mutate({ grantId: g.id })}>
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 px-6 py-3">
                <Select value={who} onValueChange={setWho}>
                  <SelectTrigger className="w-48" aria-label="Person">
                    <SelectValue placeholder="Person" />
                  </SelectTrigger>
                  <SelectContent>
                    {(members.data ?? []).map((m: { user: { id: string; name: string | null; email: string | null } }) => (
                      <SelectItem key={m.user.id} value={m.user.id}>
                        {m.user.name || m.user.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={ttl} onValueChange={setTtl}>
                  <SelectTrigger className="w-32" aria-label="How long">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TTLS.map((t) => (
                      <SelectItem key={t.sec} value={String(t.sec)}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline"
                  size="sm"
                  disabled={!who || grant.isPending}
                  onClick={() => grant.mutate({ stack, userId: who, ...(Number(ttl) ? { ttlSec: Number(ttl) } : {}) })}
                >
                  Grant
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
