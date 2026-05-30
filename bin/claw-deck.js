#!/usr/bin/env node
/**
 * claw-deck headless CLI — runs a single chat/vision request through Ollama
 * (or any OpenAI-compatible endpoint) using the same settings DB as the GUI.
 *
 * Usage:
 *   claw-deck run --task "summarize this" [--model llama3] [--backend chat|vision]
 *                 [--image ./pic.png] [--system "..."] [--json]
 *   claw-deck settings [--json]
 *   claw-deck help
 *
 * Designed to work without Electron — reads %APPDATA%/claw-deck/data/clawdeck.db
 * (or platform equivalent) directly.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

function userDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'claw-deck');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'claw-deck');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claw-deck');
}

function dbPath() { return path.join(userDataDir(), 'data', 'clawdeck.db'); }

function loadSettings() {
  const p = dbPath();
  if (!fs.existsSync(p)) return {};
  let Database;
  try { Database = require('better-sqlite3'); } catch {
    console.error('[warn] better-sqlite3 not installed in this context; falling back to defaults');
    return {};
  }
  const db = new Database(p, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT key,value FROM settings').all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  } finally {
    db.close();
  }
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function chat(opts) {
  const url = `${(opts.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
  const body = {
    model: opts.model,
    stream: false,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.prompt }
    ]
  };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.message?.content ?? '';
}

async function vision(opts) {
  const base = (opts.openaiCompatUrl || opts.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const imgB64 = fs.readFileSync(opts.image).toString('base64');
  const mime = opts.image.toLowerCase().endsWith('.jpg') || opts.image.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const body = {
    model: opts.model,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: opts.prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imgB64}` } }
      ]
    }]
  };
  const headers = { 'content-type': 'application/json' };
  if (opts.openaiCompatKey) headers['authorization'] = `Bearer ${opts.openaiCompatKey}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Vision ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}

function help() {
  console.log(`claw-deck headless CLI

Usage:
  claw-deck run --task "<prompt>" [--backend chat|vision] [--model <name>]
                [--image <path>] [--system "<prompt>"] [--json]
  claw-deck settings [--json]
  claw-deck help

Reads settings from: ${dbPath()}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    help();
    return 0;
  }
  const cmd = argv[0];
  const { flags } = parseFlags(argv.slice(1));
  const settings = loadSettings();

  if (cmd === 'settings') {
    if (flags.json) console.log(JSON.stringify(settings, null, 2));
    else for (const [k, v] of Object.entries(settings)) console.log(`${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return 0;
  }

  if (cmd === 'run') {
    const prompt = flags.task || flags.prompt;
    if (!prompt || prompt === true) { console.error('--task required'); return 2; }
    const backend = flags.backend || (flags.image ? 'vision' : 'chat');
    const model = flags.model || (backend === 'vision' ? settings.visionModel : settings.chatModel);
    if (!model) { console.error(`No model configured for backend ${backend}. Pass --model or set it in Settings.`); return 2; }

    const opts = {
      prompt: String(prompt),
      system: typeof flags.system === 'string' ? flags.system : undefined,
      model,
      ollamaUrl: settings.ollamaUrl,
      openaiCompatUrl: settings.openaiCompatUrl,
      openaiCompatKey: settings.openaiCompatKey,
      image: typeof flags.image === 'string' ? flags.image : undefined
    };
    const out = backend === 'vision' ? await vision(opts) : await chat(opts);
    if (flags.json) console.log(JSON.stringify({ backend, model, output: out }));
    else process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));
    return 0;
  }

  console.error(`Unknown command: ${cmd}`);
  help();
  return 2;
}

main().then(code => process.exit(code || 0)).catch(err => {
  console.error(`[error] ${err.message || err}`);
  process.exit(1);
});
