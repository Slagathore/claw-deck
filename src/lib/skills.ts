/**
 * Pure helpers for OpenClaw skills (SKILL.md bundles).
 *
 * A skill is a folder `<workspace>/skills/<slug>/` containing a `SKILL.md` with
 * YAML frontmatter (`name`, `description`) plus a markdown body of instructions,
 * and any supporting files. This matches the OpenClaw / ClawHub skill format
 * (clawhub publishes `SKILL.md` + supporting files; installs into `./skills`).
 */

export interface SkillMeta {
  slug: string;        // folder name; also the frontmatter `name`
  name: string;        // human title (H1), falls back to slug
  description: string;
}

/** Folder/frontmatter slug: lowercase, hyphenated, safe. */
export function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

/** Extract `name` / `description` from a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const block = m[1];
  const get = (key: string): string | undefined => {
    const r = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm').exec(block);
    if (!r) return undefined;
    let v = r[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    return v;
  };
  return { name: get('name'), description: get('description') };
}

/** Title-case a slug for the H1 (e.g. "agent-transcript" -> "Agent Transcript"). */
export function titleFromSlug(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Build a SKILL.md from a name + description (+ optional body). */
export function buildSkillMd(name: string, description: string, body?: string): string {
  const slug = slugify(name);
  const title = name.trim() || titleFromSlug(slug);
  const desc = description.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const defaultBody = `Describe what this skill does and, importantly, **when** OpenClaw should reach for it.

## Instructions

- Give the agent focused, step-by-step guidance.
- One skill = one capability. Keep it tight.

## Examples

- Show a representative invocation and the expected behavior.`;
  return `---
name: ${slug}
description: "${desc}"
---

# ${title}

${body && body.trim() ? body.trim() : defaultBody}
`;
}
