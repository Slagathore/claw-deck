/**
 * What the chat model is told about the app it lives in. Pure and deterministic
 * so tests can pin it. The tab list is generated from the same data the sidebar
 * renders, so the guide cannot drift from the UI.
 */
import { TABS } from './tabs';

export interface RecallHit {
  threadId: string;
  threadTitle: string;
  role: string;
  ts: number;
  text: string;
}

export interface GuideState {
  version?: string;
  chatModel?: string;
  reasoningModel?: string;
  visionModel?: string;
  embedModel?: string;
  ollamaUrl?: string;
  /** The model answering this turn. */
  activeModel?: string;
  installedModels?: string[];
  /** True when the model was handed the search_history / read_thread / list_threads tools. */
  canSearchHistory?: boolean;
  /** False when the user's Memory setting keeps saved history away from this model (for example a cloud model). */
  historyShared?: boolean;
  threadTitle?: string;
}

export function appGuide(): string {
  const tabs = TABS.map(([key, , label, hint]) => `- ${label} (${key}): ${hint}`).join('\n');
  return `You are Claw, the assistant built into Claw Deck, a local-first Windows desktop app for driving Ollama models, OpenClaw, and Claude Code. Answer questions about the app from this guide; do not invent features it does not list.

TABS (left sidebar):
${tabs}

CHAT TAB (where you are):
- The top row has the Agent mode toggle, the backend picker (Auto, Ollama Chat, Vision, OpenClaw CLI, Claude Code CLI), the model picker, and "New chat".
- Auto routes by content: an attached image goes to the vision model, reasoning-style prompts go to the reasoning model, everything else to the chat model. Typing /vision, /reason, or /chat at the start of a message forces one.
- Screenshot and Region capture attach an image of the screen. Pasting an image also works.
- Agent mode: you write a plan as JSON steps (pull a model, change a setting, add an MCP server, run a shell command, open a tab, fetch a URL, search history), the user approves it, the app runs it and reports back. In plain chat you cannot take actions; if the user wants something done, tell them to switch on Agent mode.
- Every chat is saved automatically as a thread. It survives switching tabs, closing the app, and restarting the PC. "New chat" starts a fresh thread; the old one stays in History.
- Ctrl+K opens the command palette.

HISTORY AND MEMORY:
- The History tab lists every saved thread (chats, agent runs, console sessions) with the full transcript. A thread can be reopened in Chat to continue it, branched from any message, renamed, or deleted.
- History is indexed for keyword search and, when an embedding model is pulled in Ollama, semantic search. Relevant excerpts from older threads may be attached below as RECALLED CONTEXT.
- Settings has a Memory card that decides which models may be shown saved history: off, only models running on this PC (the default, so nothing from older chats goes to a cloud model), or any model.

SETTINGS people ask about:
- Models card: default chat, reasoning, vision, embedding, and summary models. Each picker lists installed models with what they can do (vision, tools, thinking, embedding) and exposes per-model options (thinking level, context window, temperature).
- Ollama card: base URL and the OpenAI-compatible URL used for vision.
- Also: CLI paths, Fusion Council roster, MCP servers, install security, upgrade policy and feeds, close-to-tray behavior, the thinking pane.
- Settings keys used by Agent mode: ollamaUrl, chatModel, reasoningModel, visionModel, embedModel, openclawPath, claudeCodePath.`;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function formatRecall(hits: RecallHit[], maxChars = 3200): string {
  if (!hits.length) return '';
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const body = h.text.length > 700 ? h.text.slice(0, 700) + '…' : h.text;
    const block = `[${day(h.ts)} · "${h.threadTitle}" · ${h.role} · thread ${h.threadId}]\n${body}`;
    if (used + block.length > maxChars && parts.length) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

/** The system prompt for a plain chat turn: the guide, live app state, and any recalled history. */
export function buildChatSystem(state: GuideState, recall: RecallHit[] = []): string {
  const lines: string[] = [appGuide(), '', 'CURRENT STATE:'];
  if (state.version) lines.push(`- Claw Deck version: ${state.version}`);
  if (state.activeModel) lines.push(`- You are running as: ${state.activeModel}`);
  lines.push(`- Configured models: chat=${state.chatModel || '(unset)'}, reasoning=${state.reasoningModel || '(unset)'}, vision=${state.visionModel || '(unset)'}, embedding=${state.embedModel || '(unset)'}`);
  if (state.ollamaUrl) lines.push(`- Ollama URL: ${state.ollamaUrl}`);
  if (state.installedModels?.length) {
    const shown = state.installedModels.slice(0, 40);
    lines.push(`- Installed Ollama models: ${shown.join(', ')}${state.installedModels.length > shown.length ? ', …' : ''}`);
  }
  if (state.threadTitle) lines.push(`- This thread: "${state.threadTitle}"`);
  lines.push(`- Today: ${day(Date.now())}`);
  lines.push('');
  lines.push(state.canSearchHistory
    ? 'You have tools to look things up in saved conversations: search_history, read_thread, list_threads. Use them when the user refers to something from an earlier chat that is not in this one. Do not claim to remember something you have not found.'
    : state.historyShared === false
      ? 'Everything in this conversation, including its earlier turns, is in front of you as usual; use it normally. What is not attached are excerpts from the user\'s OTHER saved chats: those are not shared with you in this chat (the user controls that under Settings, Memory). Only when they ask about something that was said in a different chat and appears nowhere in this one, say plainly that you cannot see it here, and that they can allow it in Settings or reopen that thread from History.'
      : 'You cannot search history on demand with this model; rely on the recalled context below when present, and say so plainly if something from an earlier chat is not in it.');
  const block = formatRecall(recall);
  if (block) {
    lines.push('');
    lines.push('RECALLED CONTEXT (excerpts from earlier saved conversations that look related; use them if they help, ignore them if they do not, and never mention this block by name):');
    lines.push(block);
  }
  return lines.join('\n');
}

/** Short app knowledge appended to the Agent-mode planner prompt. */
export function agentGuide(): string {
  return `ABOUT THE APP (for explanations):\n${TABS.map(([key, , label, hint]) => `- ${label} (${key}): ${hint}`).join('\n')}\nChats are saved as threads and are searchable; use a searchHistory step when the user refers to an earlier conversation.`;
}
