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

  // Keep onPhase in a ref so the socket effect depends ONLY on wsUrl. The caller
  // passes a fresh inline onPhase each render; if the effect depended on it, every
  // setPhase would re-run the effect and tear down + recreate the WebSocket before
  // it finished connecting — a reconnect storm that never receives termStarted.
  const onPhaseRef = React.useRef(onPhase);
  React.useEffect(() => {
    onPhaseRef.current = onPhase;
  }, [onPhase]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;

    // Defer a tick so React StrictMode's synchronous mount→cleanup→mount cancels
    // the throwaway run before it opens a socket. The /term ticket is single-use,
    // so a discarded first connection would consume it and the real mount would
    // get 'unauthorized'.
    const timer = setTimeout(() => {
      if (disposed) return;

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
      try {
        fit.fit();
      } catch {
        // host not laid out yet; the ResizeObserver below fits once it is. Must not
        // abort here — the WebSocket is created next and a throw would skip it.
      }

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

    onPhaseRef.current?.('connecting');

    ws.onopen = () => {
      onPhaseRef.current?.('open');
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
          onPhaseRef.current?.('disabled', code);
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
        onPhaseRef.current?.('closed');
      }
    };

    ws.onerror = () => onPhaseRef.current?.('error');
    ws.onclose = (ev) => {
      if (!closedByExit) {
        if (ev.code === 4403) onPhaseRef.current?.('disabled', ev.reason || 'forbidden');
        else if (ev.code === 4401) onPhaseRef.current?.('error', 'unauthorized');
        else onPhaseRef.current?.('closed', ev.reason);
        term.writeln('\r\n\x1b[2mDisconnected.\x1b[0m');
      }
    };

      teardown = () => {
        ro.disconnect();
        dataDisposable.dispose();
        try {
          ws.close();
        } catch {
          // already closed
        }
        term.dispose();
      };
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(timer);
      teardown?.();
    };
  }, [wsUrl]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ width: '100%', height: '100%', background: '#0b1020', padding: 8, borderRadius: 12 }}
    />
  );
}
