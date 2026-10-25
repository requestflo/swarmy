/**
 * A channel's test receipt in plain words (board 55, "saved test receipts").
 * The transport reports what happened in its own terms ("HTTP 404",
 * "The operation timed out."); this says what it means and what to do.
 * Pure and browser-safe: the controller saves the raw result, the dashboard
 * and the demo read it through here.
 */

/** "Your channel's webhook was deleted on Slack's side" and friends. */
export function channelResultWords(ok: boolean, detail: string): string {
  if (ok) {
    const to = /^sent email to (.+)$/.exec(detail)?.[1];
    return to ? `Sent to ${to}.` : 'Delivered: the service accepted it.';
  }
  const d = detail.trim();
  if (/destination is not configured/i.test(d)) return 'This channel has no destination saved. Edit it and paste the address again.';
  if (/^email not sent/i.test(d)) return 'Email isn’t set up to send yet. Turn on Email and verify a sending domain.';
  const http = /\bHTTP (\d{3})(?::\s*(.+))?/.exec(d);
  if (http) {
    const code = Number(http[1]);
    const why = http[2]?.trim();
    if (code === 401 || code === 403) return 'The service refused the credentials. Paste a fresh token or webhook URL.';
    if (code === 404 || code === 410) return 'That address no longer exists; the webhook may have been deleted. Paste a new one.';
    if (code === 429) return 'The service is rate-limiting swarmy. Try again in a minute.';
    if (code >= 500) return `The service had a problem on its side (HTTP ${code}). Try again shortly.`;
    return why ? `The service turned the message down: ${why}.` : `The service turned the message down (HTTP ${code}).`;
  }
  if (/timed? ?out|timeout|aborted/i.test(d)) return 'No answer within 6 s. Check the address, and that the service is up.';
  if (/certificate|tls|ssl/i.test(d)) return 'The address’s certificate isn’t trusted, so nothing was sent.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|Unable to connect|fetch failed|ConnectionRefused/i.test(d)) {
    return 'swarmy couldn’t reach that address. Check the host name, and that the controller can reach it.';
  }
  return d.endsWith('.') ? d : `${d}.`;
}
