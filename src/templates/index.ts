/** Starting points for a new project. All text here is written for this app. */
import { encodeText } from '../core/hash';
import { cv } from './cv';
import { proposal } from './proposal';
import { thesis } from './thesis';
import type { Template, TemplateFile } from './types';

export type { Template, TemplateFile } from './types';

const article = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref} % clickable links, without colours or boxes

\\title{An Article}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A short summary of the article.
\\end{abstract}

\\section{Introduction}
Start writing here. Inline math looks like $e^{i\\pi} + 1 = 0$, and displayed math like
\\begin{equation}
  \\int_0^1 x^2 \\, dx = \\frac{1}{3}. \\label{eq:integral}
\\end{equation}
Equation~\\ref{eq:integral} is referenced by its label, and \\cite{knuth1984} is a citation.

\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`;

const references = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`;

const reportMain = `\\documentclass[11pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref} % clickable links, without colours or boxes
\\graphicspath{{figures/}}

\\title{A Longer Report}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\include{chapters/introduction}
\\include{chapters/methods}
\\include{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`;

const slides = `\\documentclass{beamer}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{bookmark} % builds the PDF's outline in one run, so one compile is enough

% Black and white: titles and bullets in black, no navigation symbols.
% For a colour, give the structure one, such as fg=teal.
\\setbeamercolor{structure}{fg=black}
\\setbeamertemplate{navigation symbols}{}

\\title{A Short Talk}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{First slide}
  \\begin{itemize}
    \\item One point
    \\item Another point
  \\end{itemize}
\\end{frame}

\\end{document}
`;

const blank: Template = {
  id: 'blank',
  name: 'Blank',
  description: 'An empty document and an images folder',
  mainFile: 'main.tex',
  files: [
    {
      path: 'main.tex',
      text: '\\documentclass[11pt,a4paper]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n\\usepackage{graphicx}\n\\graphicspath{{images/}}\n\n\\begin{document}\n\n\\end{document}\n',
    },
  ],
  dirs: ['images'],
};

/** In the order the new-project dialog shows them; the first is preselected. */
export const TEMPLATES: Template[] = [
  blank,
  thesis,
  proposal,
  cv,
  {
    id: 'article',
    name: 'Article',
    description: 'One file with a bibliography',
    mainFile: 'main.tex',
    files: [
      { path: 'main.tex', text: article },
      { path: 'references.bib', text: references },
    ],
  },
  {
    id: 'report',
    name: 'Report',
    description: 'Chapters in their own folder',
    mainFile: 'main.tex',
    files: [
      { path: 'main.tex', text: reportMain },
      { path: 'chapters/introduction.tex', text: '\\chapter{Introduction}\n\\label{ch:introduction}\n\nWhy this work matters. See also \\cite{knuth1984}.\n' },
      { path: 'chapters/methods.tex', text: '\\chapter{Methods}\n\\label{ch:methods}\n\nHow the work was done.\n' },
      { path: 'chapters/conclusion.tex', text: '\\chapter{Conclusion}\n\\label{ch:conclusion}\n\nWhat was learned, with a look back at Chapter~\\ref{ch:introduction}.\n' },
      { path: 'references.bib', text: references },
    ],
    dirs: ['figures'],
  },
  {
    id: 'slides',
    name: 'Slides',
    description: 'A beamer presentation',
    mainFile: 'main.tex',
    files: [{ path: 'main.tex', text: slides }],
  },
];

/** The bytes of a template file, as they are written into the new project. */
export function templateFileBytes(file: TemplateFile): Uint8Array {
  return 'text' in file ? encodeText(file.text) : file.bytes();
}
