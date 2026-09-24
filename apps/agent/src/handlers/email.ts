/**
 * Email service: probe outbound SMTP (port 25) from this node. Opens a TCP
 * connection to each target in turn and reads the 220 banner, then QUITs —
 * no mail is sent. Answers "can this node deliver directly?" for the
 * controller's port-25 notice (protocol/email.ts).
 */
import { connect } from 'node:net';
import type { ProbeSmtpPayload, ProbeSmtpResult, SmtpProbeAttempt } from '@swarmy/core/protocol';

function classify(e: NodeJS.ErrnoException): NonNullable<SmtpProbeAttempt['error']>['kind'] {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'unreachable';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns';
    case 'ETIMEDOUT':
      return 'timeout';
    default:
      return 'other';
  }
}

export function probeOne(host: string, port: number, budgetMs: number): Promise<SmtpProbeAttempt> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const sock = connect({ host, port });
    const done = (a: Omit<SmtpProbeAttempt, 'host' | 'port' | 'ms'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.write('QUIT\r\n');
      } catch {
        // socket may already be gone
      }
      sock.destroy();
      resolve({ host, port, ms: Date.now() - started, ...a });
    };
    const timer = setTimeout(
      () => done({ ok: false, error: { kind: 'timeout', message: `no answer within ${budgetMs}ms` } }),
      budgetMs,
    );
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      done(line.startsWith('220') ? { ok: true, banner: line.slice(0, 200) } : { ok: false, banner: line.slice(0, 200), error: { kind: 'other', message: `unexpected banner: ${line.slice(0, 120)}` } });
    });
    sock.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, error: { kind: classify(e), message: e.message } }));
  });
}

export async function probeSmtp(p: ProbeSmtpPayload): Promise<ProbeSmtpResult> {
  const attempts: SmtpProbeAttempt[] = [];
  for (const t of p.targets) {
    const a = await probeOne(t.host, t.port, p.perTargetMs ?? 6_000);
    attempts.push(a);
    if (a.ok) break;
  }
  return { attempts, reachable: attempts.some((a) => a.ok) };
}
