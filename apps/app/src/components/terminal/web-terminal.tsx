import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Phase = 'connecting' | 'open' | 'disabled' | 'closed' | 'error';

interface WebTerminalProps {
  /** WS url, already carrying the single-use ?ticket=… */
  wsUrl: string;
  /** Shown when the agent forbids exec / node shell. */
  onPhase?: (phase: Phase, detail?: string) => void;
  className?: string;
}

const b64encode = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64decode = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * xterm.js terminal bound to the controller `/term/ws` data plane.
 *
 * Framing (matches @swarmy/core/protocol terminal.ts):
 *   browser → controller : { type:'termInput', payload:{ data, encoding:'base64', seq } }
 *                          { type:'termResize', payload:{ cols, rows } }
 *   controller → browser : { type:'termStarted'|'termData'|'termExit', payload }
 *
 * We hand-roll the attach binding (rather than addon-attach) to control framing,
 * base64 + resize.
 */
export function WebTerminal({ wsUrl, onPhase, className }: WebTerminalProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'var(--font-mono, "Geist Mono", monospace)',
      fontSize: 13,
      theme: { background: '#0b1020' },
      convertEol: false,
      scrollback: 5_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let seq = 0;
    let closedByExit = false;
    const ws = new WebSocket(wsUrl);

    const sendResize = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'termResize', payload: { cols: term.cols, rows: term.rows } }));
    };

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // host detached
      }
    });
    ro.observe(host);

    onPhase?.('connecting');

    ws.onopen = () => {
      onPhase?.('open');
      sendResize();
      term.focus();
    };

    const dataDisposable = term.onData((data: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'termInput',
          payload: { data: b64encode(data), encoding: 'base64', seq: seq++ },
        }),
      );
    });

    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'termStarted') {
        if (msg.payload?.ok === false) {
          const code = (msg.payload.error as { code?: string })?.code ?? 'forbidden';
          onPhase?.('disabled', code);
          term.writeln(`\r\n\x1b[31mTerminal unavailable: ${code}\x1b[0m`);
        }
        return;
      }
      if (msg.type === 'termData' && typeof msg.payload?.data === 'string') {
        term.write(b64decode(msg.payload.data as string));
        return;
      }
      if (msg.type === 'termExit') {
        closedByExit = true;
        const code = msg.payload?.exitCode;
        term.writeln(`\r\n\x1b[2mSession ended${code != null ? ` (exit ${code})` : ''}.\x1b[0m`);
        onPhase?.('closed');
      }
    };

    ws.onerror = () => onPhase?.('error');
    ws.onclose = (ev) => {
      if (!closedByExit) {
        if (ev.code === 4403) onPhase?.('disabled', ev.reason || 'forbidden');
        else if (ev.code === 4401) onPhase?.('error', 'unauthorized');
        else onPhase?.('closed', ev.reason);
        term.writeln('\r\n\x1b[2mDisconnected.\x1b[0m');
      }
    };

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      try {
        ws.close();
      } catch {
        // already closed
      }
      term.dispose();
    };
  }, [wsUrl, onPhase]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ width: '100%', height: '100%', background: '#0b1020', padding: 8, borderRadius: 12 }}
    />
  );
}
