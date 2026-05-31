import { describe, it, expect } from 'vitest';
import { slugify, parseSkillFrontmatter, buildSkillMd, titleFromSlug } from '../src/lib/skills';

describe('skills helpers', () => {
  it('slugifies names', () => {
    expect(slugify('My Cool Skill!')).toBe('my-cool-skill');
    expect(slugify('  Postgres  Backups  ')).toBe('postgres-backups');
    expect(slugify('')).toBe('skill');
    expect(slugify('***')).toBe('skill');
  });

  it('titleFromSlug humanizes', () => {
    expect(titleFromSlug('agent-transcript')).toBe('Agent Transcript');
    expect(titleFromSlug('pg_backup')).toBe('Pg Backup');
  });

  it('parses real OpenClaw SKILL.md frontmatter', () => {
    const md = [
      '---',
      'name: agent-transcript',
      'description: "Add a redacted agent session transcript to a GitHub PR."',
      '---',
      '',
      '# Agent Transcript',
      'body'
    ].join('\n');
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe('agent-transcript');
    expect(fm.description).toBe('Add a redacted agent session transcript to a GitHub PR.');
  });

  it('returns empty when no frontmatter', () => {
    expect(parseSkillFrontmatter('# just a heading')).toEqual({});
  });

  it('buildSkillMd round-trips through the parser', () => {
    const md = buildSkillMd('Postgres Backups', 'Create and verify nightly Postgres backups.');
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe('postgres-backups');
    expect(fm.description).toBe('Create and verify nightly Postgres backups.');
    expect(md).toContain('# Postgres Backups');
    expect(md).toContain('## Instructions');
  });

  it('buildSkillMd escapes quotes in the description', () => {
    const md = buildSkillMd('Quote Test', 'He said "hi" to the agent.');
    expect(md).toContain('description: "He said \\"hi\\" to the agent."');
    expect(parseSkillFrontmatter(md).description).toBe('He said "hi" to the agent.');
  });

  it('buildSkillMd keeps a custom body', () => {
    const md = buildSkillMd('X', 'desc', '## Custom\nhello');
    expect(md).toContain('## Custom');
    expect(md).not.toContain('One skill = one capability');
  });
});
