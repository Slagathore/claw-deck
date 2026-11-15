import React, { useState } from 'react';
import {
  type ModelInfo, type ModelParams, type ModelSlot, type ThinkLevel,
  capLabels, describeModel, findModel, formatContext, slotFit, sortForSlot
} from '../lib/modelSlots';

interface Props {
  slot: ModelSlot;
  label: string;
  hint?: string;
  value: string;
  onChange: (model: string) => void;
  models: ModelInfo[];
  /** Per-model options (thinking level, context window, temperature). Omit to hide them. */
  params?: Record<string, ModelParams>;
  onParams?: (next: Record<string, ModelParams>) => void;
  /** The global Thinking setting, shown as what "default" means. */
  globalThink?: ThinkLevel;
}

const CUSTOM = '__custom__';
const thinkValue = (t: ThinkLevel | undefined) => t === undefined ? 'default' : t === true ? 'on' : t === false ? 'off' : t;

/**
 * A model picker that knows what each installed model can do. Models that suit
 * the slot come first, unsuitable ones are listed separately with the reason,
 * and the options the chosen model actually supports appear underneath.
 */
export default function ModelSelect({ slot, label, hint, value, onChange, models, params, onParams, globalThink }: Props) {
  const info = findModel(models, value);
  const [custom, setCustom] = useState(false);
  const typing = custom || (!!value && !info) || models.length === 0;

  const sorted = sortForSlot(models, slot);
  const suited = sorted.filter(m => slotFit(m, slot).fit !== 'bad');
  const unsuited = sorted.filter(m => slotFit(m, slot).fit === 'bad');
  const fit = info ? slotFit(info, slot) : null;

  const p = params?.[value] ?? {};
  function setParam(patch: Partial<ModelParams>) {
    if (!onParams || !value) return;
    const next: ModelParams = { ...p, ...patch };
    (Object.keys(next) as (keyof ModelParams)[]).forEach(k => { if (next[k] === undefined || (next[k] as any) === '') delete next[k]; });
    const all = { ...(params ?? {}) };
    if (Object.keys(next).length) all[value] = next; else delete all[value];
    onParams(all);
  }

  const canThink = !!info?.capabilities.includes('thinking');
  const showOptions = !!onParams && !!value && slot !== 'embed';

  return (
    <div className="model-pick">
      <label className="label"><strong>{label}</strong>{hint ? ` (${hint})` : ''}</label>
      <div className="row">
        {!typing ? (
          <select
            value={info ? info.name : value}
            onChange={e => { if (e.target.value === CUSTOM) setCustom(true); else onChange(e.target.value); }}
            style={{ flex: 1 }}
          >
            {!value && <option value="">(none selected)</option>}
            {suited.length > 0 && (
              <optgroup label="Suited to this slot">
                {suited.map(m => <option key={m.name} value={m.name}>{m.name}  ·  {describeModel(m)}</option>)}
              </optgroup>
            )}
            {unsuited.length > 0 && (
              <optgroup label="Installed, but not suited">
                {unsuited.map(m => <option key={m.name} value={m.name}>{m.name}  ·  {slotFit(m, slot).why}</option>)}
              </optgroup>
            )}
            <option value={CUSTOM}>Type a model name…</option>
          </select>
        ) : (
          <>
            <input value={value} onChange={e => onChange(e.target.value)} placeholder="model tag, e.g. llama3.2" style={{ flex: 1 }} />
            {models.length > 0 && (
              <button onClick={() => { setCustom(false); if (!findModel(models, value)) onChange(suited[0]?.name ?? ''); }} title="Choose from the models installed in Ollama">
                Pick installed
              </button>
            )}
          </>
        )}
      </div>

      <div className="caps">
        {info && capLabels(info).map(c => <span key={c} className="badge ok">{c}</span>)}
        {info?.cloud && <span className="badge">cloud</span>}
        {info?.contextLength ? <span className="label">{formatContext(info.contextLength)} max</span> : null}
        {info?.capsSource === 'guess' && <span className="label" title="This Ollama version does not report capabilities, so they are inferred from the model name.">(capabilities guessed from the name)</span>}
        {fit && fit.fit !== 'good' && <span style={{ color: fit.fit === 'bad' ? 'var(--bad)' : 'var(--warn)', fontSize: 12 }}>{fit.fit === 'bad' ? '✗' : '!'} {fit.why}</span>}
        {fit && fit.fit === 'good' && <span className="label">{fit.why}</span>}
        {!info && value && models.length > 0 && <span style={{ color: 'var(--warn)', fontSize: 12 }}>Not installed in Ollama. Pull it from the Library tab, or check the name.</span>}
        {models.length === 0 && <span className="label">Ollama is not reachable, so installed models cannot be listed.</span>}
      </div>

      {showOptions && (
        <div className="opts">
          {info && !canThink ? (
            <span className="label">No thinking mode on this model (the Thinking setting is skipped for it).</span>
          ) : (
            <label className="label" title="Reasoning pass for this model. Default follows the Thinking setting under UX.">
              Thinking{' '}
              <select
                value={thinkValue(p.think)}
                onChange={e => { const v = e.target.value; setParam({ think: v === 'default' ? undefined : v === 'off' ? false : v === 'on' ? true : (v as ThinkLevel) }); }}
              >
                <option value="default">default ({thinkValue(globalThink ?? false)})</option>
                {['off', 'on', 'low', 'medium', 'high'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          )}
          {info?.cloud ? (
            <span className="label">Cloud model: context window is managed by the provider.</span>
          ) : (
            <label className="label" title="Context window in tokens (num_ctx). Blank uses Ollama's default, which is often far below what the model supports. Bigger windows use more VRAM.">
              Context window{' '}
              <input
                type="number" min={2048} step={1024} max={info?.contextLength}
                value={p.num_ctx ?? ''} placeholder="Ollama default"
                onChange={e => { const n = Number(e.target.value); setParam({ num_ctx: e.target.value === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.floor(n)) }); }}
              />
              {info?.contextLength ? ` of ${info.contextLength.toLocaleString()}` : ''}
            </label>
          )}
          <label className="label" title="Sampling temperature. Blank uses the model's own default.">
            Temperature{' '}
            <input
              type="number" min={0} max={2} step={0.1} style={{ width: 80 }}
              value={p.temperature ?? ''} placeholder="default"
              onChange={e => { const n = Number(e.target.value); setParam({ temperature: e.target.value === '' || !Number.isFinite(n) ? undefined : n }); }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
