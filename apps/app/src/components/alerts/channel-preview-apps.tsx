import * as React from 'react';
import {
  renderDiscordBody,
  renderGotifyBody,
  renderNtfyBody,
  renderTelegramText,
  type AlertNotification,
} from '@swarmy/core';

/**
 * Each app's native look, drawn from the very payload the controller sends
 * (`@swarmy/core` alert-render*.ts) — nothing here writes its own words.
 */

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function Byline({ name, at, tag }: { name: string; at: string; tag?: string }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
      <b className="font-semibold">{name}</b>
      {tag ? <span className="bg-accent text-muted-foreground rounded px-1 font-mono text-[9.5px] font-semibold">{tag}</span> : null}
      <span className="text-muted-foreground text-[11px]">Today at {hhmm(at)}</span>
    </p>
  );
}

/** Slack / Teams incoming webhook: the one-line `{ text }`, posted under the webhook's own name. */
export function TextPreview({ text, at }: { text: string; at: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Byline name="Incoming webhook" tag="APP" at={at} />
      <p className="text-[13px] leading-snug break-words">{text}</p>
    </div>
  );
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string }>;
  footer: { text: string };
}

/** Discord: the webhook's username and an embed with its severity colour down the side. */
export function DiscordPreview({ n }: { n: AlertNotification }): React.JSX.Element {
  const body = renderDiscordBody(n) as { username: string; embeds: DiscordEmbed[] };
  const e = body.embeds[0]!;
  return (
    <div className="flex flex-col gap-1">
      <Byline name={body.username} tag="APP" at={n.at} />
      {/* The stripe is the embed's own colour, as Discord paints it. */}
      <div className="bg-muted/60 flex max-w-md flex-col gap-1 rounded border-l-4 px-3 py-2" style={{ borderLeftColor: `#${e.color.toString(16).padStart(6, '0')}` }}>
        <b className="text-[13px] font-semibold">{e.title}</b>
        <p className="text-[13px] leading-snug break-words">{e.description}</p>
        {e.fields.length ? (
          <dl className="grid grid-cols-3 gap-2 pt-1">
            {e.fields.map((f) => (
              <div key={f.name} className="min-w-0">
                <dt className="text-[11.5px] font-semibold">{f.name}</dt>
                <dd className="truncate text-[12px]">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="text-muted-foreground text-[10.5px]">{e.footer.text} • Today at {hhmm(n.at)}</p>
      </div>
    </div>
  );
}

/** MarkdownV2 → text: `\x` is a literal x, `*…*` bold, `_…_` italic (the only marks swarmy sends). */
function markdownV2(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  let bold = false;
  let italic = false;
  const flush = (): void => {
    if (!buf) return;
    const key = out.length;
    out.push(bold ? <b key={key}>{buf}</b> : italic ? <i key={key} className="not-italic opacity-80">{buf}</i> : buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) buf += text[++i];
    else if (c === '*' || c === '_') {
      flush();
      if (c === '*') bold = !bold;
      else italic = !italic;
    } else buf += c;
  }
  flush();
  return out;
}

/** Telegram: the bot's MarkdownV2 message in a chat bubble. */
export function TelegramPreview({ n }: { n: AlertNotification }): React.JSX.Element {
  return (
    <div className="bg-muted/60 flex max-w-sm flex-col gap-1 rounded-2xl rounded-bl-sm px-3 py-2">
      <p className="text-[13px] leading-snug break-words whitespace-pre-line">{markdownV2(renderTelegramText(n))}</p>
      <span className="text-muted-foreground self-end font-mono text-[10.5px]">{hhmm(n.at)}</span>
    </div>
  );
}

/** ntfy tags that are emoji shortcodes show as the icon; the rest read as tags. */
const NTFY_EMOJI: Record<string, string> = { white_check_mark: '✅', warning: '⚠️', rotating_light: '🚨', information_source: 'ℹ️', moneybag: '💰' };

/** ntfy / Gotify: a phone notification card with the priority they're sent at. */
export function PushPreview({ n, kind, where }: { n: AlertNotification; kind: 'ntfy' | 'gotify'; where: string }): React.JSX.Element {
  const topic = where.split('/').slice(1).join('/');
  const b = (kind === 'ntfy' ? renderNtfyBody(n, topic) : renderGotifyBody(n)) as { title: string; message: string; priority: number; tags?: string[] };
  const icons = (b.tags ?? []).map((t) => NTFY_EMOJI[t]).filter(Boolean).join(' ');
  const tags = (b.tags ?? []).filter((t) => !NTFY_EMOJI[t]);
  return (
    <div className="bg-muted/60 flex max-w-sm flex-col gap-1 rounded-xl px-3 py-2.5">
      <p className="text-muted-foreground flex justify-between gap-2 font-mono text-[10.5px]">
        <span className="truncate">{kind} · {where}</span>
        <span>{hhmm(n.at)}</span>
      </p>
      <b className="text-[13.5px] font-semibold">{icons ? `${icons} ` : ''}{b.title}</b>
      <p className="text-[13px] leading-snug break-words whitespace-pre-line">{b.message}</p>
      <p className="text-muted-foreground font-mono text-[10.5px]">
        priority {b.priority}
        {tags.length ? ` · tags: ${tags.join(', ')}` : ''}
      </p>
    </div>
  );
}
