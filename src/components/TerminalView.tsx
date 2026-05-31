import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ConsoleSession } from '../store/console';

/**
 * xterm.js view for a PTY-backed Console session. Renders the real terminal
 * stream (colors, cursor, line editing), forwards keystrokes to the pty, and
 * keeps the pty sized to the viewport. Keyed by session id in the parent, so it
 * remounts per session and replays that session's buffer on mount.
 */
export default function TerminalView({ session }: { session: ConsoleSession }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      cursorBlink: session.exited == null,
      theme: { background: '#0c0f17', foreground: '#cfd6e6' }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // Restore prior output so switching session tabs doesn't lose scrollback.
    if (session.output) term.write(session.output);

    const onData = term.onData(d => { window.api.runner.input(session.id, d, true); });

    const doFit = () => {
      try { fit.fit(); window.api.runner.resize(session.id, term.cols, term.rows); } catch { /* ignore */ }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    // Live stream (separate from the store subscription; only future events).
    const off = window.api.runner.onEvent((ev: any) => {
      if (ev.id !== session.id) return;
      if (ev.kind === 'stdout' || ev.kind === 'stderr') term.write(ev.data);
      else if (ev.kind === 'error') term.write(`\r\n[error] ${ev.data}\r\n`);
      else if (ev.kind === 'exit') term.write(`\r\n[exit ${ev.data}]\r\n`);
    });

    if (session.exited == null) term.focus();

    return () => { off(); onData.dispose(); ro.disconnect(); term.dispose(); };
    // Remount only when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return <div ref={ref} style={{ flex: 1, minHeight: 220, overflow: 'hidden', background: '#0c0f17', borderRadius: 6, padding: 4 }} />;
}
