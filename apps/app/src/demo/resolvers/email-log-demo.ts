/** The storefront app's mail in the demo send log (`email.log`): shapes mirror email/log.ts EmailEvent. */
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
export const APP_CRED = 'app-storefront.demo01@swarmy';

/** A day of storefront mail, one row per recipient event (accepted → delivered, a bounce, a retry). */
export function demoLog(): Array<Record<string, unknown>> {
  const row = (min: number, event: string, rcpt: string, subject: string, extra: Record<string, unknown> = {}) => ({
    ts: ago(min), event, mtaId: `m${min}`, messageId: `<${min}@acme.dev>`, credential: APP_CRED, sender: 'hello@acme.dev', rcpt, domain: 'acme.dev', subject, smtpCode: 0, detail: '', source: 'smtp', ...extra,
  });
  const out: Array<Record<string, unknown>> = [];
  const people = ['ada@example.com', 'grace@example.com', 'alan@example.com', 'jo@shopper.dev', 'sam@shopper.dev'];
  for (let i = 0; i < 18; i++) {
    const min = 2 + i * 23;
    const rcpt = people[i % people.length]!;
    const subject = i % 3 === 0 ? 'Your receipt' : 'Your order has shipped';
    out.push(row(min - 1, 'delivered', rcpt, subject), row(min, 'accepted', rcpt, subject));
  }
  out.push(row(120, 'bounced', 'gone@example.org', 'Your receipt', { smtpCode: 550, detail: 'smtp; 550 5.1.1 user unknown', source: 'report' }));
  out.push(row(121, 'accepted', 'gone@example.org', 'Your receipt'));
  out.push(row(30, 'deferred', 'slow@example.net', 'Welcome', { smtpCode: 451, detail: 'greylisted, retrying' }));
  out.push(row(31, 'accepted', 'slow@example.net', 'Welcome'));
  return out.sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1));
}
