// Director capability library — what each agent can actually PRODUCE, seeded from a live
// probe (2026-06, judged from real output). The governing rule: text LLMs emit TEXT assets
// (SVG, pixel-drawing GDScript/canvas code, chiptune as MML, SFX as synthesis code / sfxr
// params). NONE emit raster images or audio FILES — those come from a generator (local
// z-image-turbo, or MCP: Picsart / Higgsfield for images, Splice / Higgsfield for audio /
// Higgsfield for 3D). So the director must never ask a text agent for a .png/.wav: it asks
// for the text form, and routes binary assets to a generator.
//
// Probe finding worth remembering: every roster model emits all the text-asset kinds, but
// REASONING models (qwen3.5, deepseek, kimi, glm, gemini) burn their token budget thinking
// and emit nothing unless reasoning is suppressed (think:false) or the budget is large.
// `reasoningHeavy` flags those (the empty-reply guard in the engine drops + fails them over).

import { AdvisorKey, advisorKey } from './roles';
import { RosterAgent } from './agents';

/** Asset kinds a text model can emit directly (as text/code). */
export type TextAssetKind = 'svg' | 'gdscript' | 'code' | 'chiptune' | 'sfx' | 'shader';
/** Asset kinds that need a real generator — NOT a text LLM. */
export type BinaryAssetKind = 'rasterImage' | 'audioFile' | 'model3d';

export interface AgentAssetCaps { emits: TextAssetKind[]; reasoningHeavy: boolean; note?: string }

const ALL: TextAssetKind[] = ['svg', 'gdscript', 'code', 'chiptune', 'sfx', 'shader'];

export const AGENT_ASSET_CAPS: Record<AdvisorKey, AgentAssetCaps> = {
  'qwen-coder': { emits: ALL, reasoningHeavy: false, note: 'strongest asset/code emitter — clean SVG + GDScript + MML + sfxr' },
  nemotron:     { emits: ALL, reasoningHeavy: false, note: 'full asset emission, no reasoning suppression needed' },
  minimax:      { emits: ALL, reasoningHeavy: false, note: 'pixel-style SVG via crispEdges rects' },
  qwen35:       { emits: ALL, reasoningHeavy: true },
  deepseek:     { emits: ALL, reasoningHeavy: true },
  kimi:         { emits: ALL, reasoningHeavy: true },
  'gemini-hot': { emits: ['svg', 'gdscript', 'code', 'chiptune'], reasoningHeavy: true, note: 'does NOT honor think:false via Ollama — unreliable for direct asset emission' },
  claude:       { emits: ALL, reasoningHeavy: false },
  codex:        { emits: ALL, reasoningHeavy: false },
  unknown:      { emits: ALL, reasoningHeavy: true, note: 'e.g. glm-5.2 — emits text assets; treat as reasoning-heavy' },
};

/** Where a binary asset must come from (it is NOT produced by a text agent). */
export const BINARY_GENERATORS: Record<BinaryAssetKind, string> = {
  rasterImage: 'local z-image-turbo, or MCP Picsart / Higgsfield image generation',
  audioFile: 'MCP Splice or Higgsfield audio generation',
  model3d: 'MCP Higgsfield generate_3d',
};

export function canEmit(key: AdvisorKey, kind: TextAssetKind): boolean {
  return (AGENT_ASSET_CAPS[key] ?? AGENT_ASSET_CAPS.unknown).emits.includes(kind);
}
export function isReasoningHeavy(key: AdvisorKey): boolean {
  return (AGENT_ASSET_CAPS[key] ?? AGENT_ASSET_CAPS.unknown).reasoningHeavy;
}

/** Probed capability results (live override): model tag → { capabilityId: 'pass'|'fail'|… }. */
export type ProbedCaps = Record<string, Record<string, string>>;

/** How good an agent is as a code/asset BUILDER. Priors from the library (clean emitters beat
 *  reasoning-heavy ones), boosted by live probe evidence when present. Higher = better. */
export function builderScore(agent: RosterAgent, probed?: ProbedCaps): number {
  const caps = AGENT_ASSET_CAPS[advisorKey(agent)] ?? AGENT_ASSET_CAPS.unknown;
  let s = caps.emits.length - (caps.reasoningHeavy ? 3 : 0);
  const p = agent.model ? probed?.[agent.model] : undefined;
  if (p) s += Object.values(p).filter((v) => v === 'pass').length * 2;   // probed evidence outweighs priors
  return s;
}

/** Edit-capable agents, best-builder first — so the director never defaults an asset/build
 *  job to a less-capable agent. Probed results (if any) refine the order. */
export function rankEditors(agents: RosterAgent[], probed?: ProbedCaps): RosterAgent[] {
  return agents.filter((a) => a.capabilities?.canEdit).sort((a, b) => builderScore(b, probed) - builderScore(a, probed));
}

/** Compact capability test prompts for the IN-APP probe (the standalone tool has its own,
 *  richer set). Each asks for ONLY the artifact so the result is judgeable + small. */
export const PROBE_PROMPTS: { id: string; prompt: string; pass: (t: string) => boolean }[] = [
  { id: 'svg', prompt: 'Output ONLY a valid <svg> for a 16x16 red heart. No prose, no fences.', pass: (t) => /<svg[\s>][\s\S]*<\/svg>/i.test(t) },
  { id: 'gdscript', prompt: 'Output ONLY Godot 4 GDScript building a 4x4 sprite via Image+ImageTexture (set_pixel). No prose.', pass: (t) => /(set_pixelv?|ImageTexture|Image\.create)/i.test(t) },
  { id: 'chiptune', prompt: 'Output ONLY 8 notes of a cheerful chiptune in MML with a tempo (T) and octave (O). No prose.', pass: (t) => (/\b[tT]\d{2,3}\b/.test(t) || /\b[oO]\d\b/.test(t)) && /[a-gA-G]/.test(t) },
  { id: 'sfx', prompt: 'Output ONLY sfxr params (JSON) or a Web Audio recipe for a laser SFX. No prose.', pass: (t) => /(sfxr|oscillator|frequenc|waveform|square|sawtooth|noise|envelope|sweep)/i.test(t) },
];

/** Boilerplate appended to a builder's task so it never claims to produce a binary asset it
 *  cannot, and uses the right text form instead (the director-library rule, in prompt form). */
export function assetGuidance(): string {
  return [
    'ASSET RULES (you are a text model — you CANNOT output binary image or audio files):',
    '• Visuals: emit SVG, or pixel-drawing code (Godot Image.set_pixel/ImageTexture, or an HTML canvas routine). Never claim a .png/.jpg you did not actually write to a file.',
    '• Audio (SFX / 8-bit music): emit synthesis code (Godot AudioStreamGenerator, Web Audio) or sfxr/jsfxr parameters + chiptune in MML / note data. Never claim a .wav/.ogg you did not write.',
    '• If a real raster/audio/3D file is genuinely required, write a TODO(asset) marking it for the generator step (z-image-turbo / Picsart / Higgsfield / Splice) and supply a code/SVG/MML placeholder so the game still runs.',
  ].join('\n');
}
