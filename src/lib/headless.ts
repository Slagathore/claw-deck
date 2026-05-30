/**
 * Pure helpers used by bin/claw-deck.js. Kept in src/lib so we can unit-test
 * without spawning the binary.
 */

export function parseFlags(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function pickModel(settings: Record<string, any>, backend: 'chat' | 'vision', override?: string): string | undefined {
  if (override) return override;
  if (backend === 'vision') return settings.visionModel;
  return settings.chatModel;
}

export function chooseBackend(flags: Record<string, string | boolean>): 'chat' | 'vision' {
  if (flags.backend === 'vision' || flags.backend === 'chat') return flags.backend;
  if (flags.image && typeof flags.image === 'string') return 'vision';
  return 'chat';
}
