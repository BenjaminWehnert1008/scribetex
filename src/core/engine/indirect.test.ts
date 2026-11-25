import { describe, expect, it } from 'vitest';
import { indirectFiles } from './indirect';

describe('indirectFiles', () => {
  it('finds the language files babel will look for', () => {
    const source = '\\documentclass{article}\n\\usepackage[english, main=ngerman]{babel}\n';
    expect(indirectFiles(source).sort()).toEqual(['english.ldf', 'ngerman.ldf']);
  });

  it('reads languages from the class options and from a shared \\usepackage', () => {
    const source = '\\documentclass[a4paper,12pt,french]{scrartcl}\n\\usepackage[T1]{fontenc}\n\\usepackage[dutch]{csquotes,babel}\n';
    const files = indirectFiles(source);
    expect(files).toContain('french.ldf');
    expect(files).toContain('dutch.ldf');
    // An option of another package is not a language.
    expect(files).not.toContain('T1.ldf');
  });

  it('finds biblatex styles and BibTeX style files', () => {
    const source = [
      '\\usepackage[backend=bibtex, style=apa, sorting={nyt}]{biblatex}',
      '\\usepackage[bibstyle=ieee,citestyle=numeric-comp]{biblatex}',
      '\\bibliographystyle{apacite}',
    ].join('\n');
    expect(indirectFiles(source).sort()).toEqual(['apa.bbx', 'apa.cbx', 'apacite.bst', 'ieee.bbx', 'numeric-comp.cbx']);
  });

  it('ignores what is commented out and what is not a plain name', () => {
    const source = '% \\usepackage[spanish]{babel}\n\\usepackage[provide=*, \\mylang]{babel}\n\\bibliographystyle{\\mystyle}\n';
    expect(indirectFiles(source)).toEqual([]);
  });
});
