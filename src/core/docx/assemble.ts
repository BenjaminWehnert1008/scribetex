/** Puts the converted blocks together: main.tex with the preamble, and one file per chapter or section. */
import type { Path } from '../types';
import { type Block, type CaptionBlock, TOKEN } from './blocks';
import type { Converter } from './convert';
import { escapeText, safeKey, slug } from './latex-text';
import { LATEX_DEFAULT_LABELS } from './styles';

export const FRONT_MATTER = /^(abstract|summary|executive summary|zusammenfassung|kurzfassung|management summary|acknowledge?ments?|danksagung|preface|vorwort|foreword|geleitwort|(table of )?contents|inhalt(sverzeichnis)?|list of (figures|tables|abbreviations|symbols)|abbildungsverzeichnis|tabellenverzeichnis|abkürzungsverzeichnis|abkuerzungsverzeichnis|symbolverzeichnis|glossar(y)?|nomenclature|references|bibliography|literatur(verzeichnis)?|quellen(verzeichnis)?|works cited|eidesstattliche (erklärung|versicherung)|selbstständigkeitserklärung|declaration( of authorship)?|statutory declaration|résumé|resumen|riassunto|samenvatting)$/i;

export const REFERENCE_HEADINGS = /^(references|bibliography|literatur(verzeichnis)?|quellen(verzeichnis)?|works cited|bibliographie|bibliografía|bibliografia|referenties|literatuurlijst)$/i;

export const BABEL: Record<string, string> = {
  de: 'ngerman',
  nl: 'dutch',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  'pt-br': 'brazilian',
  fr: 'french',
};

export interface Assembled {
  main: string;
  parts: { path: Path; text: string }[];
}

/** Builds the project files from the blocks. */
export function assemble(conv: Converter, meta: { title: string; author: string | null; fileName: string; hasTitleStyle: boolean }): Assembled & { documentClass: 'article' | 'report' } {
  let blocks = conv.blocks;

  // Captions join the picture or table next to them.
  blocks = attachCaptions(blocks);

  const headings = blocks.filter((block): block is Extract<Block, { kind: 'heading' }> => block.kind === 'heading');
  const top = headings.length ? Math.min(...headings.map((heading) => heading.level)) : 1;
  const topCount = headings.filter((heading) => heading.level === top).length;
  const words = blocks.reduce((sum, block) => sum + ('plain' in block ? block.plain.split(/\s+/).length : 0), 0);
  const hasToc = blocks.some((block) => block.kind === 'toc');
  const report = topCount >= 2 && (hasToc || (topCount >= 3 && words >= 4000));
  const documentClass = report ? 'report' : 'article';
  const commands = report ? ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'] : ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];

  // Labels: a bookmark that something points to becomes \label{sec:…}, \label{fig:…} ...
  const labelNames = new Map<string, string>();
  const takenLabels = new Set<string>();
  const nameLabel = (bookmark: string, prefix: string, text: string) => {
    if (labelNames.has(bookmark) || !conv.referenced.has(bookmark)) return;
    const base = `${prefix}${slug(text, 30) || safeKey(bookmark.replace(/^_+/, ''), 'ref').toLowerCase()}`;
    let label = base;
    for (let n = 2; takenLabels.has(label); n++) label = `${base}-${n}`;
    takenLabels.add(label);
    labelNames.set(bookmark, label);
  };
  for (const block of blocks) {
    const caption = block.kind === 'figure' || block.kind === 'table' ? block.caption : undefined;
    if (caption) caption.bookmarks.forEach((name) => nameLabel(name, block.kind === 'table' ? 'tab:' : 'fig:', caption.plain));
    if (block.kind === 'heading') block.bookmarks.forEach((name) => nameLabel(name, 'sec:', block.plain));
    if (block.kind === 'figure') block.bookmarks.forEach((name) => nameLabel(name, 'fig:', `figure ${name}`));
    if (block.kind === 'caption') block.bookmarks.forEach((name) => nameLabel(name, block.target === 'table' ? 'tab:' : 'fig:', block.plain));
  }
  for (const name of conv.referenced) nameLabel(name, '', safeKey(name.replace(/^_+/, ''), 'ref').toLowerCase());

  // Pictures get names from their captions where there is one.
  nameImages(blocks, conv);

  let refName: string | null = null;
  let contentsName: string | null = null;
  const lofNames: { figures?: string; tables?: string } = {};
  // A heading right before the bibliography or a table of contents is replaced by LaTeX's own.
  const kept: Block[] = [];
  for (const block of blocks) {
    const previous = kept[kept.length - 1];
    if (block.kind === 'bibliography' && previous?.kind === 'heading') {
      refName = previous.latex;
      kept.pop();
    }
    if (block.kind === 'toc' && previous?.kind === 'heading') {
      if (block.which === 'contents') contentsName = previous.latex;
      else lofNames[block.which] = previous.latex;
      kept.pop();
    }
    if (block.kind === 'bibliography' && kept.some((item) => item.kind === 'bibliography')) continue;
    kept.push(block);
  }
  blocks = kept;
  if (conv.bib.size > 0 && !blocks.some((block) => block.kind === 'bibliography')) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'heading' && REFERENCE_HEADINGS.test(last.plain)) {
      refName = last.latex;
      blocks.pop();
    }
    blocks.push({ kind: 'bibliography' });
  }
  if (conv.bib.size === 0) blocks = blocks.filter((block) => block.kind !== 'bibliography');

  const render = (list: Block[]): string => renderBlocks(list, conv, commands, top, labelNames);

  // Split at top-level headings.
  const groups: { heading: Extract<Block, { kind: 'heading' }> | null; blocks: Block[] }[] = [{ heading: null, blocks: [] }];
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === top) groups.push({ heading: block, blocks: [block] });
    else groups[groups.length - 1]!.blocks.push(block);
  }
  const folder = report ? 'chapters' : 'sections';
  const split = topCount >= 2;
  const parts: { path: Path; text: string }[] = [];
  const bodyLines: string[] = [];
  const taken = new Set<string>();
  let index = 0;
  const front = groups[0]!.blocks;
  const tail: Block[] = [];
  // The bibliography is written in main.tex, after the last chapter.
  const takeBibliography = (list: Block[]) => {
    const at = list.findIndex((block) => block.kind === 'bibliography');
    if (at !== -1 && list.slice(at + 1).every((block) => block.kind === 'bibliography' || (block.kind === 'para' && block.plain === ''))) {
      tail.push(...list.splice(at));
    }
  };
  if (split) {
    for (const group of groups.slice(1)) takeBibliography(group.blocks);
    if (groups.length > 1 && front.length) {
      const text = render(front);
      if (text.trim()) {
        const path = `${folder}/00-front-matter.tex` as Path;
        parts.push({ path, text });
        bodyLines.push(`\\input{${path.replace(/\.tex$/, '')}}`);
      }
    }
    for (const group of groups.slice(1)) {
      index++;
      const name = `${String(index).padStart(2, '0')}-${slug(group.heading?.plain ?? '', 32) || 'part'}`;
      let unique = name;
      for (let n = 2; taken.has(unique); n++) unique = `${name}-${n}`;
      taken.add(unique);
      const path = `${folder}/${unique}.tex` as Path;
      parts.push({ path, text: render(group.blocks) });
      bodyLines.push(`${report ? '\\include' : '\\input'}{${path.replace(/\.tex$/, '')}}`);
    }
  } else {
    takeBibliography(blocks);
    const text = render(blocks.filter((block) => !tail.includes(block)));
    bodyLines.push(text);
  }
  if (tail.length) bodyLines.push(render(tail));

  // Preamble
  const pt = conv.styles.fontSizeHalfPoints ? Math.round(conv.styles.fontSizeHalfPoints / 2) : 11;
  const size = pt <= 10 ? '10pt' : pt >= 12 ? '12pt' : '11pt';
  const paper = Math.abs(conv.pageWidthTwips - 12240) < 200 ? 'letterpaper' : 'a4paper';
  const lang = (conv.styles.language ?? '').toLowerCase();
  const babel = BABEL[lang] ?? BABEL[lang.split('-')[0] ?? ''];
  // Pictures, labels and references are filled in first, so the package checks below see the final text.
  const body = finalizeTokens(bodyLines.join('\n\n'), conv, labelNames);
  const finalParts = parts.map((part) => ({ path: part.path, text: finalizeTokens(part.text, conv, labelNames) }));
  const allText = [body, ...finalParts.map((part) => part.text)].join('\n');
  const needs = (pattern: RegExp) => pattern.test(allText);

  const pre: string[] = [];
  pre.push(`\\documentclass[${size},${paper}]{${documentClass}}`);
  pre.push('\\usepackage[utf8]{inputenc}');
  pre.push('\\usepackage[T1]{fontenc}');
  pre.push('\\usepackage{lmodern}');
  if (babel) pre.push(`\\usepackage[${babel}]{babel}`);
  if (conv.usedPackages.has('amsmath') || needs(/\\(mathbb|text\{|boxed|boxtimes|genfrac|iint|checkmark|blacksquare|square|bigstar|mathfrak|mathcal|lesssim|gtrsim|therefore|because|nexists|varnothing)/)) pre.push('\\usepackage{amsmath,amssymb}');
  if (conv.usedPackages.has('graphicx')) pre.push('\\usepackage{graphicx}');
  if (conv.usedPackages.has('booktabs')) {
    pre.push('\\usepackage{array,booktabs}');
    if (needs(/\\begin\{longtable\}/)) pre.push('\\usepackage{longtable}');
    if (conv.usedPackages.has('multirow')) pre.push('\\usepackage{multirow}');
    pre.push('% A table column of a given share of the text width, set ragged right.');
    pre.push('\\newcolumntype{L}[1]{>{\\raggedright\\arraybackslash}p{\\dimexpr#1\\linewidth-2\\tabcolsep\\relax}}');
  }
  if (needs(/\\begin\{(itemize|enumerate)\}\[/)) pre.push('\\usepackage{enumitem}');
  if (needs(/\\(uline|sout)\{/)) pre.push('\\usepackage[normalem]{ulem}');
  pre.push('\\usepackage[hidelinks]{hyperref}');
  if (refName) pre.push(`\\renewcommand{\\${report ? 'bibname' : 'refname'}}{${refName}}`);
  if (contentsName) pre.push(`\\renewcommand{\\contentsname}{${contentsName}}`);
  if (lofNames.figures) pre.push(`\\renewcommand{\\listfigurename}{${lofNames.figures}}`);
  if (lofNames.tables) pre.push(`\\renewcommand{\\listtablename}{${lofNames.tables}}`);
  pre.push('');
  const titleLatex = conv.title.length ? conv.title.join(' \\\\ ') : escapeText(meta.title);
  const fullTitle = conv.subtitle.length ? `${titleLatex}\\\\[1ex]\\large ${conv.subtitle.join(' \\\\ ')}` : titleLatex;
  pre.push(`\\title{${fullTitle}}`);
  pre.push(`\\author{${conv.authors.length ? conv.authors.join(' \\and ') : meta.author ? escapeText(meta.author) : ''}}`);
  pre.push(`\\date{${conv.date ?? ''}}`);

  const header = [
    `% Imported from the Word file "${meta.fileName.replace(/[\r\n%]/g, ' ')}".`,
    ...(conv.warnings.size ? ['% Worth a look:', ...[...conv.warnings].map((warning) => `% - ${warning}`)] : []),
    '',
  ];
  const main = [
    ...header,
    ...pre,
    '',
    '\\begin{document}',
    ...(meta.hasTitleStyle ? ['\\maketitle', ''] : []),
    body,
    '',
    '\\end{document}',
    '',
  ]
    .join('\n')
    .replace(/\n{3,}(?=\\end\{document\})/, '\n\n');
  return { main, parts: finalParts, documentClass };
}

export function attachCaptions(blocks: Block[]): Block[] {
  const out: Block[] = [];
  const used = new Set<Block>();
  const floats = new Map<Block, { caption: CaptionBlock; above: boolean }>();
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[k]!;
    if (block.kind !== 'caption') continue;
    const before = blocks[k - 1];
    const after = blocks[k + 1];
    const fits = (other: Block | undefined) =>
      other && !used.has(other) && (other.kind === 'figure' || other.kind === 'table') && (block.target === null || block.target === other.kind) && !floats.get(other)?.caption;
    // Tables are usually captioned above, pictures below.
    let target: Block | undefined;
    let above = false;
    const preferAfter = block.target === 'table' || (block.target === null && after?.kind === 'table');
    if (preferAfter && fits(after)) {
      target = after;
      above = true;
    } else if (fits(before)) target = before;
    else if (fits(after)) {
      target = after;
      above = true;
    }
    if (target) {
      used.add(block);
      floats.set(target, { caption: block, above });
    }
  }
  for (const block of blocks) {
    if (used.has(block)) continue;
    if (block.kind === 'caption') {
      out.push({ kind: 'para', latex: block.full, plain: block.plain, bookmarks: block.bookmarks });
      if (block.deferred.length) out.push({ kind: 'raw', latex: footnoteTexts(block.deferred) });
      continue;
    }
    const float = floats.get(block);
    if (float && (block.kind === 'figure' || block.kind === 'table')) out.push({ ...block, caption: { ...float.caption, above: float.above } });
    else out.push(block);
  }
  return out;
}

export function nameImages(blocks: Block[], conv: Converter): void {
  const takenNames = new Set<string>();
  let figureNumber = 0;
  const give = (part: string, desired: string) => {
    const image = conv.images.get(part);
    if (!image || image.name) return;
    let name = desired;
    for (let n = 2; takenNames.has(name); n++) name = `${desired}-${n}`;
    takenNames.add(name);
    image.name = name;
  };
  for (const block of blocks) {
    if (block.kind !== 'figure') continue;
    const caption = block.caption;
    if (!caption) continue;
    figureNumber++;
    block.images.forEach((image, k) => give(image.part, `figure-${String(figureNumber).padStart(2, '0')}${slug(caption.plain, 28) ? `-${slug(caption.plain, 28)}` : ''}${block.images.length > 1 ? `-${k + 1}` : ''}`));
  }
  for (const part of conv.usedImages) {
    const base = part.split('/').pop()!.replace(/\.[^.]+$/, '');
    give(part, slug(base, 40) || 'picture');
  }
}

export function footnoteTexts(texts: string[]): string {
  if (texts.length === 0) return '';
  const lines = [`\\addtocounter{footnote}{-${texts.length}}`];
  for (const text of texts) lines.push(`\\stepcounter{footnote}\\footnotetext{${text}}`);
  return lines.join('\n');
}

export function renderBlocks(blocks: Block[], conv: Converter, commands: string[], top: number, labels: Map<string, string>): string {
  const out: string[] = [];
  const labelFor = (bookmarks: string[]) => bookmarks.map((name) => (labels.has(name) ? `\\label{${labels.get(name)}}` : '')).join('');
  let k = 0;
  while (k < blocks.length) {
    const block = blocks[k]!;
    switch (block.kind) {
      case 'heading': {
        const depth = Math.max(0, block.level - top);
        const command = commands[Math.min(depth, commands.length - 1)]!;
        const star = FRONT_MATTER.test(block.plain.replace(/[:.]$/, '')) ? '*' : '';
        const short = block.short && !star ? `[${block.short}]` : '';
        let line = `\\${command}${star}${short}{${block.latex}}${labelFor(block.bookmarks)}`;
        if (star && depth <= 1) line += `\n\\addcontentsline{toc}{${command}}{${block.short ?? block.latex}}`;
        if (block.deferred.length) line += `\n${footnoteTexts(block.deferred)}`;
        out.push(line);
        k++;
        break;
      }
      case 'para': {
        if (block.align || block.quote) {
          const env = block.quote ? 'quote' : block.align === 'center' ? 'center' : 'flushright';
          const group: string[] = [];
          while (k < blocks.length) {
            const next = blocks[k]!;
            if (next.kind !== 'para' || (block.quote ? !next.quote : next.align !== block.align || next.quote)) break;
            group.push(next.latex);
            k++;
          }
          out.push(`\\begin{${env}}\n${group.join('\n\n')}\n\\end{${env}}`);
        } else {
          out.push(block.latex);
          k++;
        }
        break;
      }
      case 'code':
        out.push(`\\begin{verbatim}\n${block.text.replace(/\\end\{verbatim\}/g, '\\end {verbatim}')}\n\\end{verbatim}`);
        k++;
        break;
      case 'item': {
        const lines: string[] = [];
        const stack: { ordered: boolean }[] = [];
        let listId: string | null = null;
        while (k < blocks.length && blocks[k]!.kind === 'item') {
          const item = blocks[k] as Extract<Block, { kind: 'item' }>;
          // A new list right after another one (another numbering) starts afresh.
          if (item.depth === 0 && stack.length > 0 && listId !== null && item.numId !== listId) {
            while (stack.length) lines.push(`${'  '.repeat(stack.length - 1)}\\end{${stack.pop()!.ordered ? 'enumerate' : 'itemize'}}`);
            lines.push('');
          }
          if (item.depth === 0) listId = item.numId;
          const depth = Math.min(item.depth, stack.length, 3);
          while (stack.length > depth + 1) lines.push(`${'  '.repeat(stack.length - 1)}\\end{${stack.pop()!.ordered ? 'enumerate' : 'itemize'}}`);
          if (stack.length === depth + 1 && stack[depth]!.ordered !== item.ordered) lines.push(`${'  '.repeat(depth)}\\end{${stack.pop()!.ordered ? 'enumerate' : 'itemize'}}`);
          if (stack.length === depth) {
            const options: string[] = [];
            if (item.ordered) {
              if (item.label && item.label !== LATEX_DEFAULT_LABELS[depth]) options.push(`label=${item.label}`);
              if (item.value !== 1) options.push(`start=${item.value}`);
            }
            lines.push(`${'  '.repeat(depth)}\\begin{${item.ordered ? 'enumerate' : 'itemize'}}${options.length ? `[${options.join(', ')}]` : ''}`);
            stack.push({ ordered: item.ordered });
            conv.counts.lists += depth === 0 ? 1 : 0;
          }
          lines.push(`${'  '.repeat(depth + 1)}\\item ${item.latex}`);
          k++;
        }
        while (stack.length) lines.push(`${'  '.repeat(stack.length - 1)}\\end{${stack.pop()!.ordered ? 'enumerate' : 'itemize'}}`);
        out.push(lines.join('\n'));
        break;
      }
      case 'figure': {
        const caption = block.caption;
        const graphics = block.images.map((image) => `${TOKEN}F${image.part}${TOKEN}${block.images.length > 1 ? Math.min(image.width || 1 / block.images.length, 0.98 / block.images.length) : image.width}${TOKEN}`);
        const body = graphics.join('\\hfill\n  ');
        if (caption) {
          const captionLine = `\\caption${caption.short ? `[${caption.short}]` : ''}{${caption.latex}}${labelFor([...caption.bookmarks, ...block.bookmarks])}`;
          const lines = ['\\begin{figure}[htbp]', '  \\centering'];
          if (caption.above) lines.push(`  ${captionLine}`);
          lines.push(`  ${body}`);
          if (!caption.above) lines.push(`  ${captionLine}`);
          lines.push('\\end{figure}');
          if (caption.deferred.length) lines.push(footnoteTexts(caption.deferred));
          out.push(lines.join('\n'));
        } else out.push(`\\begin{center}\n  ${body}${labelFor(block.bookmarks)}\n\\end{center}`);
        k++;
        break;
      }
      case 'table': {
        const caption = block.caption;
        const captionLine = caption ? `\\caption${caption.short ? `[${caption.short}]` : ''}{${caption.latex}}${labelFor(caption.bookmarks)}` : '';
        const long = block.rows > 25;
        const lines: string[] = [];
        if (long) {
          lines.push(`\\begin{longtable}{${block.spec}}`);
          if (caption) lines.push(`${captionLine}\\\\`);
          lines.push('\\toprule');
          if (block.head.length) {
            lines.push(...block.head, '\\midrule', '\\endfirsthead', '\\toprule', ...block.head, '\\midrule', '\\endhead');
          }
          lines.push('\\bottomrule', '\\endlastfoot');
          lines.push(...block.body);
          lines.push('\\end{longtable}');
        } else {
          const tabular = [`\\begin{tabular}{${block.spec}}`, '\\toprule', ...block.head, ...(block.head.length ? ['\\midrule'] : []), ...block.body, '\\bottomrule', '\\end{tabular}'];
          if (caption) {
            lines.push('\\begin{table}[htbp]', '\\centering');
            if (caption.above) lines.push(captionLine);
            lines.push(...tabular);
            if (!caption.above) lines.push(captionLine);
            lines.push('\\end{table}');
          } else lines.push('\\begin{center}', ...tabular, '\\end{center}');
        }
        if (block.deferred.length) lines.push(footnoteTexts(block.deferred));
        if (caption?.deferred.length) lines.push(footnoteTexts(caption.deferred));
        out.push(lines.join('\n'));
        k++;
        break;
      }
      case 'raw':
        if (!(block.latex === '\\clearpage' && (out.length === 0 || out[out.length - 1] === '\\clearpage'))) out.push(block.latex);
        k++;
        break;
      case 'toc':
        out.push(block.which === 'contents' ? '\\tableofcontents' : block.which === 'figures' ? '\\listoffigures' : '\\listoftables');
        k++;
        break;
      case 'bibliography':
        out.push('\\bibliographystyle{plain}\n\\bibliography{references}');
        k++;
        break;
      case 'caption':
        out.push(block.latex);
        k++;
        break;
    }
  }
  // A page break as the very last thing in a file only adds an empty page.
  while (out.length && out[out.length - 1] === '\\clearpage') out.pop();
  return `${out.join('\n\n')}\n`;
}

/** Fills in pictures, labels and references once every name is known. */
export function finalizeTokens(text: string, conv: Converter, labels: Map<string, string>): string {
  return text
    .replace(new RegExp(`${TOKEN}F([^${TOKEN}]*)${TOKEN}([^${TOKEN}]*)${TOKEN}`, 'g'), (_, part: string, width: string) => graphic(conv, part, Number(width) || 0, true))
    .replace(new RegExp(`${TOKEN}L([^${TOKEN}]*)${TOKEN}`, 'g'), (_, name: string) => (labels.has(name) ? `\\label{${labels.get(name)}}` : ''))
    .replace(new RegExp(`${TOKEN}R(\\d+)${TOKEN}`, 'g'), (_, index: string) => {
      const ref = conv.refTokens[Number(index)]!;
      const label = labels.get(ref.bookmark);
      if (!label) return ref.text;
      if (ref.kind === 'link') return `\\hyperref[${label}]{${ref.text}}`;
      if (ref.kind === 'pageref') return `\\pageref{${label}}`;
      if (ref.kind === 'nameref') return `\\hyperref[${label}]{${ref.text}}`;
      return ref.prefix ? `${ref.prefix}~\\ref{${label}}` : `\\ref{${label}}`;
    });
}

export function graphic(conv: Converter, part: string, width: number, block: boolean): string {
  const image = conv.images.get(part);
  if (!image) return '';
  const path = `images/${image.name ?? 'picture'}.${image.ext}`;
  if (!image.supported) return `\\fbox{\\parbox{0.8\\linewidth}{\\centering Picture \\texttt{${escapeText(path)}} is in a format pdfLaTeX cannot show. Convert it to PNG and include it here.}}`;
  const size = width > 0 ? `width=${width >= 0.995 ? '' : width.toFixed(2)}\\linewidth` : block ? 'width=0.8\\linewidth' : 'height=1em';
  return `\\includegraphics[${size}]{${path}}`;
}
