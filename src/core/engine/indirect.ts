import { stripComments } from '../latex/deps';

/**
 * Files a document asks for without naming them. A babel language option
 * needs "<language>.ldf", a biblatex style needs "<style>.bbx" and ".cbx",
 * and \bibliographystyle needs "<name>.bst".
 *
 * When a file that TeX was told to read is missing, it says "File not found"
 * and the engine fetches the package that has it. These files are different:
 * babel answers a missing language with "Unknown option", biblatex with "Style
 * not found", so nothing would be fetched. The compile step therefore looks
 * for them in the source and fetches their packages up front.
 *
 * The result is a list of candidates. Most class options ("a4paper", "12pt")
 * are not languages; looking such a name up finds nothing and costs nothing.
 */
export function indirectFiles(source: string): string[] {
  const text = stripComments(source);
  const files = new Set<string>();
  const add = (name: string, extension: string): void => {
    const clean = name.trim();
    if (/^[A-Za-z][A-Za-z0-9-]*$/.test(clean)) files.add(`${clean}${extension}`);
  };

  // Class options are handed on to babel, so a language may be named there.
  for (const match of text.matchAll(/\\documentclass\s*\[([^\]]*)\]/g)) {
    for (const option of splitOptions(match[1]!)) if (!option.includes('=')) add(option, '.ldf');
  }

  for (const match of text.matchAll(/\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{([^}]*)\}/g)) {
    const packages = match[2]!.split(',').map((name) => name.trim());
    const options = splitOptions(match[1]!);
    if (packages.includes('babel')) {
      for (const option of options) {
        const [key, value] = keyValue(option);
        if (value === null) add(key, '.ldf');
        else if (key === 'main') add(value, '.ldf');
      }
    }
    if (packages.includes('biblatex')) {
      for (const option of options) {
        const [key, value] = keyValue(option);
        if (value === null) continue;
        if (key === 'style' || key === 'bibstyle') add(value, '.bbx');
        if (key === 'style' || key === 'citestyle') add(value, '.cbx');
      }
    }
  }

  for (const match of text.matchAll(/\\bibliographystyle\s*\{([^}]*)\}/g)) add(match[1]!, '.bst');

  return [...files];
}

/** Splits "a, b={x,y}, c" at the commas that are not inside braces. */
function splitOptions(options: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of options) {
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function keyValue(option: string): [string, string | null] {
  const at = option.indexOf('=');
  if (at === -1) return [option.trim(), null];
  return [option.slice(0, at).trim(), option.slice(at + 1).trim().replace(/^\{|\}$/g, '')];
}
