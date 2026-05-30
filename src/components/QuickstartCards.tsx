import React from 'react';

interface Card { title: string; sub: string; prompt: string; }

const CARDS: Card[] = [
  { title: 'Ask a question',   sub: 'Test that chat works end-to-end',     prompt: 'Explain what a closure is in JavaScript, with a tiny example.' },
  { title: 'Describe an image', sub: 'Forces the vision backend (/vision)', prompt: '/vision What is in this screenshot? Read any text verbatim.' },
  { title: 'Reason step-by-step', sub: 'Uses your reasoning model (/reason)', prompt: '/reason A bat and ball cost $1.10 total. The bat costs $1 more than the ball. How much does the ball cost? Show your reasoning.' },
  { title: 'Summarize text',     sub: 'Paste anything after the prompt',     prompt: 'Summarize the following in 3 bullet points:\n\n' }
];

interface Props { onPick: (prompt: string) => void; }

export default function QuickstartCards({ onPick }: Props) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="label">Try one of these to get started:</div>
      <div className="quickstart">
        {CARDS.map(c => (
          <button key={c.title} className="qs" onClick={() => onPick(c.prompt)}>
            <span className="qs-title">{c.title}</span>
            <span className="qs-sub">{c.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
