/** Word's paragraph and character styles, and its list numbering definitions. */
import { escapeText } from './latex-text';
import { child, childrenNamed, flag, parseXml, val, type XmlElement } from './xml';

export const MONO_FONTS = /^(courier|consolas|menlo|monaco|lucida console|lucida sans typewriter|source code|fira code|fira mono|jetbrains mono|dejavu sans mono|liberation mono|andale mono|cascadia|roboto mono|inconsolata|ubuntu mono|sf mono|noto mono|pt mono)/i;

export interface RunProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  mono?: boolean;
  vertAlign?: string;
  vanish?: boolean;
}

export interface Style {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  outline?: number;
  numId?: string;
  ilvl?: number;
  run: RunProps;
  jc?: string;
}

export function readRunProps(rPr: XmlElement | undefined): RunProps {
  const props: RunProps = {};
  if (!rPr) return props;
  const set = (key: keyof RunProps, value: boolean | undefined) => {
    if (value !== undefined) (props as Record<string, unknown>)[key] = value;
  };
  set('b', flag(rPr, 'w:b'));
  set('i', flag(rPr, 'w:i'));
  const underline = val(rPr, 'w:u');
  if (child(rPr, 'w:u')) props.u = underline !== 'none' && underline !== '0';
  const strike = flag(rPr, 'w:strike') ?? flag(rPr, 'w:dstrike');
  set('strike', strike);
  set('caps', flag(rPr, 'w:caps'));
  set('smallCaps', flag(rPr, 'w:smallCaps'));
  set('vanish', flag(rPr, 'w:vanish'));
  const fonts = child(rPr, 'w:rFonts');
  const font = fonts?.attrs['w:ascii'] ?? fonts?.attrs['w:hAnsi'];
  if (font) props.mono = MONO_FONTS.test(font);
  const vertAlign = val(rPr, 'w:vertAlign');
  if (vertAlign) props.vertAlign = vertAlign;
  return props;
}

export class Styles {
  readonly byId = new Map<string, Style>();
  defaultParagraph?: string;
  language?: string;
  fontSizeHalfPoints?: number;

  constructor(xml: string | undefined) {
    if (!xml) return;
    const root = parseXml(xml);
    const defaults = child(child(child(root, 'w:docDefaults'), 'w:rPrDefault'), 'w:rPr');
    this.language = val(defaults, 'w:lang');
    const size = Number(val(defaults, 'w:sz'));
    if (Number.isFinite(size) && size > 0) this.fontSizeHalfPoints = size;
    for (const node of childrenNamed(root, 'w:style')) {
      const id = node.attrs['w:styleId'] ?? '';
      const pPr = child(node, 'w:pPr');
      const numPr = child(pPr, 'w:numPr');
      const outline = val(pPr, 'w:outlineLvl');
      const style: Style = {
        id,
        name: (val(node, 'w:name') ?? id).toLowerCase(),
        type: node.attrs['w:type'] ?? 'paragraph',
        basedOn: val(node, 'w:basedOn'),
        outline: outline !== undefined ? Number(outline) : undefined,
        numId: val(numPr, 'w:numId'),
        ilvl: val(numPr, 'w:ilvl') !== undefined ? Number(val(numPr, 'w:ilvl')) : undefined,
        run: readRunProps(child(node, 'w:rPr')),
        jc: val(pPr, 'w:jc'),
      };
      this.byId.set(id, style);
      if (node.attrs['w:default'] === '1' && style.type === 'paragraph') this.defaultParagraph = id;
    }
  }

  /** The style and the ones it is based on, nearest first. */
  chain(id: string | undefined): Style[] {
    const out: Style[] = [];
    let current = id ?? this.defaultParagraph;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const style = this.byId.get(current);
      if (!style) break;
      out.push(style);
      current = style.basedOn;
    }
    return out;
  }

  /** Run properties of a style, with inherited ones filled in. */
  runProps(id: string | undefined): RunProps {
    const merged: RunProps = {};
    for (const style of this.chain(id).reverse()) Object.assign(merged, style.run);
    return merged;
  }

  /** "heading 2" → 2, also for localised names and styles based on headings. */
  headingLevel(id: string | undefined): number | null {
    for (const style of this.chain(id)) {
      const match = /^heading\s*([1-9])$/.exec(style.name) ?? /^(?:berschrift|überschrift|titre|titolo|kop|encabezado|ttulo)\s*([1-9])$/i.exec(style.name);
      if (match) return Number(match[1]);
      if (style.outline !== undefined && style.outline >= 0 && style.outline < 9) return style.outline + 1;
    }
    return null;
  }

  is(id: string | undefined, test: RegExp): boolean {
    return this.chain(id).some((style) => test.test(style.name) || test.test(style.id.toLowerCase()));
  }

  numbering(id: string | undefined): { numId: string; ilvl: number } | null {
    for (const style of this.chain(id)) {
      if (style.numId !== undefined) return { numId: style.numId, ilvl: style.ilvl ?? 0 };
    }
    return null;
  }

  alignment(id: string | undefined): string | undefined {
    for (const style of this.chain(id)) if (style.jc) return style.jc;
    return undefined;
  }
}

export interface Level {
  format: string;
  text: string;
  start: number;
}

export class Numbering {
  readonly #abstract = new Map<string, Map<number, Level>>();
  readonly #nums = new Map<string, { abstractId: string; overrides: Map<number, Partial<Level>> }>();
  readonly #styleLinks = new Map<string, string>();

  constructor(xml: string | undefined, styles: Styles) {
    if (!xml) return;
    const root = parseXml(xml);
    for (const abstract of childrenNamed(root, 'w:abstractNum')) {
      const id = abstract.attrs['w:abstractNumId'] ?? '';
      this.#abstract.set(id, readLevels(abstract));
      const link = val(abstract, 'w:numStyleLink');
      if (link) {
        const numId = styles.numbering(link)?.numId;
        if (numId) this.#styleLinks.set(id, numId);
      }
    }
    for (const num of childrenNamed(root, 'w:num')) {
      const overrides = new Map<number, Partial<Level>>();
      for (const override of childrenNamed(num, 'w:lvlOverride')) {
        const ilvl = Number(override.attrs['w:ilvl'] ?? 0);
        const entry: Partial<Level> = {};
        const start = val(override, 'w:startOverride');
        if (start !== undefined) entry.start = Number(start);
        const lvl = child(override, 'w:lvl');
        if (lvl) Object.assign(entry, readLevel(lvl));
        overrides.set(ilvl, entry);
      }
      this.#nums.set(num.attrs['w:numId'] ?? '', { abstractId: val(num, 'w:abstractNumId') ?? '', overrides });
    }
  }

  level(numId: string, ilvl: number, depth = 0): Level {
    const num = this.#nums.get(numId);
    const fallback: Level = { format: 'bullet', text: '', start: 1 };
    if (!num) return fallback;
    const linked = this.#styleLinks.get(num.abstractId);
    if (linked && linked !== numId && depth < 3 && !this.#abstract.get(num.abstractId)?.size) return this.level(linked, ilvl, depth + 1);
    // A list defined through a numbering style keeps its levels there.
    const base = this.#abstract.get(num.abstractId)?.get(ilvl) ?? fallback;
    return { ...base, ...num.overrides.get(ilvl) };
  }

  /** Whether the override restarts the count (Word's "Restart numbering"). */
  hasStartOverride(numId: string, ilvl: number): boolean {
    return this.#nums.get(numId)?.overrides.get(ilvl)?.start !== undefined;
  }
}

export function readLevel(lvl: XmlElement): Level {
  return {
    format: val(lvl, 'w:numFmt') ?? 'decimal',
    text: val(lvl, 'w:lvlText') ?? '',
    start: Number(val(lvl, 'w:start') ?? 1),
  };
}

export function readLevels(abstract: XmlElement): Map<number, Level> {
  const levels = new Map<number, Level>();
  for (const lvl of childrenNamed(abstract, 'w:lvl')) levels.set(Number(lvl.attrs['w:ilvl'] ?? 0), readLevel(lvl));
  return levels;
}

export const COUNTER_FORMATS: Record<string, string> = {
  decimal: '\\arabic*',
  decimalZero: '\\arabic*',
  lowerLetter: '\\alph*',
  upperLetter: '\\Alph*',
  lowerRoman: '\\roman*',
  upperRoman: '\\Roman*',
};

export const PARENT_COUNTERS: Record<string, string> = { decimal: 'arabic', lowerLetter: 'alph', upperLetter: 'Alph', lowerRoman: 'roman', upperRoman: 'Roman' };

export const ENUM_NAMES = ['enumi', 'enumii', 'enumiii', 'enumiv'];

export const LATEX_DEFAULT_LABELS = ['\\arabic*.', '(\\alph*)', '\\roman*.', '\\Alph*.'];

export function isOrdered(level: Level): boolean {
  return level.format !== 'bullet' && level.format !== 'none' && COUNTER_FORMATS[level.format] !== undefined;
}

/** The enumitem label for a Word level text such as "%1." or "%1.%2)". */
export function enumLabel(level: Level, ilvl: number, numbering: Numbering, numId: string): string {
  let out = '';
  const text = level.text || `%${ilvl + 1}.`;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '%' && /[1-9]/.test(text[i + 1] ?? '')) {
      const which = Number(text[i + 1]) - 1;
      i++;
      if (which === ilvl) out += COUNTER_FORMATS[level.format] ?? '\\arabic*';
      else if (which < ilvl && which < 4) out += `\\${PARENT_COUNTERS[numbering.level(numId, which).format] ?? 'arabic'}{${ENUM_NAMES[which]}}`;
    } else out += escapeText(ch);
  }
  return out;
}
