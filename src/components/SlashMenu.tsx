import React, { useEffect, useState } from 'react';

const COMMANDS = [
  { cmd: '/chat',   desc: 'Force the default chat model' },
  { cmd: '/vision', desc: 'Force the vision model (works without an image)' },
  { cmd: '/reason', desc: 'Force the reasoning model' }
];

interface Props {
  query: string;            // The text being typed (whole input)
  onPick: (cmd: string) => void;
}

/**
 * Tiny dropdown shown above the Chat textarea when the user types `/`.
 * Filters the three slash commands and supports ↑/↓/Enter/Esc.
 */
export default function SlashMenu({ query, onPick }: Props) {
  const [sel, setSel] = useState(0);
  const trimmed = query.trimStart();
  const open = trimmed.startsWith('/') && !trimmed.includes(' ');
  const token = trimmed.split(/\s/)[0].toLowerCase();
  const matches = open ? COMMANDS.filter(c => c.cmd.startsWith(token)) : [];

  useEffect(() => { setSel(0); }, [token]);

  useEffect(() => {
    if (!open || matches.length === 0) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, matches.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Tab' || (e.key === 'Enter' && matches[sel])) {
        // Only intercept Enter if the user is still typing the slash token with no space yet.
        if (e.key === 'Tab') {
          e.preventDefault();
          onPick(matches[sel].cmd);
        }
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, matches, sel, onPick]);

  if (!open || matches.length === 0) return null;

  return (
    <div className="slash-menu">
      {matches.map((c, i) => (
        <div
          key={c.cmd}
          className={`row-item ${i === sel ? 'sel' : ''}`}
          onMouseEnter={() => setSel(i)}
          onClick={() => onPick(c.cmd)}
        >
          <code>{c.cmd}</code>
          <span className="desc">{c.desc}</span>
        </div>
      ))}
      <div className="label" style={{ padding: '2px 10px 4px' }}>Tab to insert</div>
    </div>
  );
}
