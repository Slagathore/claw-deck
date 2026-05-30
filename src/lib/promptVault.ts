/**
 * Tiny {{var}} templating for the prompt vault. Whitespace inside the braces
 * is allowed and trimmed. Unknown variables are left as-is so the user can
 * spot what was missed. `extractVariables` lists the unique names in source
 * order (handy for auto-building the variable form).
 */
const VAR_RE = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

export function extractVariables(template: string): string[] {
  if (!template) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // reset lastIndex defensively in case the same regex was used elsewhere
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(template)) !== null) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

export function applyVariables(template: string, vars: Record<string, string>): string {
  if (!template) return '';
  return template.replace(VAR_RE, (_full, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name] ?? '';
    return `{{${name}}}`;
  });
}
