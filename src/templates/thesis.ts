/** The thesis template: a report with front matter, chapters, an appendix, figures and a bibliography. */
import { exampleFigure } from './images';
import { lorem, loremLine } from './lorem';
import type { Template } from './types';

const main = String.raw`% Thesis
%
% How this project is laid out:
%   main.tex            this file: the order of the parts
%   settings/           packages, page layout and your own commands
%   frontmatter/        title page, abstract, acknowledgements, abbreviations
%   chapters/           one file per chapter
%   appendix/           material that goes after the bibliography
%   images/             pictures; \includegraphics finds them by name alone
%   bibliography/       references.bib, your library of sources
%
% Replace the lorem ipsum with your own text, and the details on the
% title page with yours.

\documentclass[11pt,a4paper,oneside]{report}

\input{settings/preamble}
\input{settings/macros}

\begin{document}

% Front matter, numbered i, ii, iii, ...
\pagenumbering{roman}
\input{frontmatter/titlepage}
\input{frontmatter/abstract}
\input{frontmatter/acknowledgements}
\tableofcontents
\listoffigures
\listoftables
\input{frontmatter/abbreviations}

% Main matter, numbered 1, 2, 3, ...
\cleardoublepage
\pagenumbering{arabic}
\include{chapters/01-introduction}
\include{chapters/02-background}
\include{chapters/03-methods}
\include{chapters/04-results}
\include{chapters/05-discussion}
\include{chapters/06-conclusion}

% Bibliography, from bibliography/references.bib
\cleardoublepage
\phantomsection
\addcontentsline{toc}{chapter}{Bibliography}
\bibliographystyle{plainnat}
\bibliography{bibliography/references}

% Appendix: chapters are lettered A, B, ...
\appendix
\include{appendix/A-supplementary}

\end{document}
`;

const preamble = String.raw`% Packages and page layout for the thesis.

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage[english]{babel}
\usepackage{microtype}

% Page layout and line spacing
\usepackage[a4paper,top=2.5cm,bottom=2.5cm,inner=3cm,outer=2.5cm,headheight=14pt]{geometry}
\usepackage{setspace}
\onehalfspacing

% Mathematics
\usepackage{amsmath}
\usepackage{amssymb}

% Figures and tables
\usepackage{graphicx}
\graphicspath{{images/}}
\usepackage{booktabs}
\usepackage[font=small,labelfont=bf]{caption}

% Citations: \citet{key} gives "Author (Year)", \citep{key} gives "(Author, Year)"
\usepackage[round,authoryear]{natbib}

% Headers and footers
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\nouppercase{\leftmark}}
\fancyfoot[C]{\thepage}
\renewcommand{\headrulewidth}{0.4pt}
\fancypagestyle{plain}{\fancyhf{}\fancyfoot[C]{\thepage}\renewcommand{\headrulewidth}{0pt}}

% Colours and links (load hyperref last)
\usepackage{xcolor}
\definecolor{accent}{HTML}{17715B}
\usepackage[colorlinks=true,linkcolor=accent,citecolor=accent,urlcolor=accent]{hyperref}
`;

const macros = String.raw`% Your own commands. Define a command once and use it everywhere.

% Details for the title page
\newcommand{\thesistitle}{Lorem Ipsum Dolor Sit Amet: Consectetur Adipiscing Elit}
\newcommand{\thesisauthor}{Your Name}
\newcommand{\thesisdegree}{Master of Science}
\newcommand{\thesisprogramme}{Lorem Ipsum Studies}
\newcommand{\thesisuniversity}{University of Lorem Ipsum}
\newcommand{\thesissupervisor}{Prof.\ Dr.\ Dolor Sit}
\newcommand{\thesisdate}{\today}

% Short forms used in the text
\newcommand{\eg}{e.g.,\ }
\newcommand{\ie}{i.e.,\ }
\newcommand{\vect}[1]{\boldsymbol{#1}}
`;

const titlepage = String.raw`% The title page. The details come from settings/macros.tex.
\begin{titlepage}
  \centering
  \vspace*{2cm}
  {\Large\scshape \thesisuniversity\par}
  \vspace{2.5cm}
  {\huge\bfseries \thesistitle\par}
  \vspace{2cm}
  {\Large \thesisauthor\par}
  \vfill
  A thesis submitted in fulfilment of the requirements\\
  for the degree of \thesisdegree\\
  in \thesisprogramme\par
  \vspace{1.5cm}
  Supervisor: \thesissupervisor\par
  \vspace{1cm}
  {\large \thesisdate\par}
\end{titlepage}
`;

const abstract = String.raw`\chapter*{Abstract}
\addcontentsline{toc}{chapter}{Abstract}

${lorem(2)}
`;

const acknowledgements = String.raw`\chapter*{Acknowledgements}
\addcontentsline{toc}{chapter}{Acknowledgements}

${lorem(1, 4)}
`;

const abbreviations = String.raw`\chapter*{Abbreviations}
\addcontentsline{toc}{chapter}{Abbreviations}

\begin{tabular}{@{}ll@{}}
  \textbf{LIP} & Lorem Ipsum Protocol \\
  \textbf{DSA} & Dolor Sit Amet \\
  \textbf{CAE} & Consectetur Adipiscing Elit \\
  \textbf{SED} & Sed Eiusmod Dolore \\
\end{tabular}
`;

const introduction = String.raw`\chapter{Introduction}
\label{ch:introduction}

${lorem(2)}

\section{Motivation}
\label{sec:motivation}

${lorem(1, 2)} As \citet{ipsum2021} show, the question is far from settled \citep{dolor2019, amet2023}.

\section{Research questions}

This thesis answers three questions:
\begin{enumerate}
  \item ${loremLine(0)}
  \item ${loremLine(6)}
  \item ${loremLine(10)}
\end{enumerate}

\section{Outline}

Chapter~\ref{ch:background} reviews earlier work, Chapter~\ref{ch:methods} describes the methods,
Chapter~\ref{ch:results} presents the results and Chapter~\ref{ch:discussion} discusses them.
Chapter~\ref{ch:conclusion} concludes.
`;

const background = String.raw`\chapter{Background}
\label{ch:background}

${lorem(1, 3)}

\section{Lorem ipsum in context}

${lorem(2, 1)} An early account is given by \citet{dolor2019}.

\section{Related work}

${lorem(1, 5)} Later studies \citep{ipsum2021, consectetur2018} extend this view.
`;

const methods = String.raw`\chapter{Methods}
\label{ch:methods}

${lorem(1)}

\section{Model}

The model relates the input $\vect{x}$ to the output $y$ through
\begin{equation}
  y = \sum_{i=1}^{n} w_i x_i + b, \label{eq:model}
\end{equation}
where $w_i$ are weights and $b$ is a bias. Equation~\eqref{eq:model} is fitted by minimising
\begin{equation}
  L(\vect{w}, b) = \frac{1}{N} \sum_{j=1}^{N} \bigl( y_j - \hat{y}_j \bigr)^2.
\end{equation}

\section{Experimental setup}

${lorem(1, 2)} Figure~\ref{fig:setup} shows the setup.

\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.6\textwidth]{example-figure}
  \caption{Lorem ipsum dolor sit amet, consectetur adipiscing elit. Replace images/example-figure.png with your own picture.}
  \label{fig:setup}
\end{figure}
`;

const results = String.raw`\chapter{Results}
\label{ch:results}

${lorem(1, 3)} Table~\ref{tab:results} summarises the measurements.

\begin{table}[htbp]
  \centering
  \caption{Lorem ipsum measurements for three conditions.}
  \label{tab:results}
  \begin{tabular}{@{}lrrr@{}}
    \toprule
    Condition & Mean & SD & $n$ \\
    \midrule
    Lorem & 12.4 & 1.3 & 24 \\
    Ipsum & 15.1 & 2.0 & 24 \\
    Dolor & 9.8  & 0.9 & 23 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{Main finding}

${lorem(2, 4)}
`;

const discussion = String.raw`\chapter{Discussion}
\label{ch:discussion}

${lorem(1, 1)} This agrees with \citet{amet2023}.

\section{Limitations}

${lorem(1, 5)}

\section{Future work}

${lorem(1, 2)}
`;

const conclusion = String.raw`\chapter{Conclusion}
\label{ch:conclusion}

${lorem(2, 3)}
`;

const appendix = String.raw`\chapter{Supplementary material}
\label{app:supplementary}

${lorem(1)}

\section{Additional table}

\begin{table}[htbp]
  \centering
  \caption{Lorem ipsum parameters.}
  \begin{tabular}{@{}ll@{}}
    \toprule
    Parameter & Value \\
    \midrule
    Lorem & 0.01 \\
    Ipsum & 128 \\
    \bottomrule
  \end{tabular}
\end{table}
`;

const references = `% Your library of sources. Cite an entry by its key, for example \\citep{ipsum2021}.
% Only cited entries appear in the bibliography.

@article{ipsum2021,
  author  = {Ipsum, Lorem and Dolor, Sit},
  title   = {Consectetur adipiscing elit sed do eiusmod},
  journal = {Journal of Lorem Ipsum},
  year    = {2021},
  volume  = {12},
  number  = {3},
  pages   = {45--67}
}

@book{dolor2019,
  author    = {Dolor, Amet},
  title     = {Tempor Incididunt ut Labore},
  publisher = {Magna Aliqua Press},
  address   = {Lorem},
  year      = {2019}
}

@inproceedings{amet2023,
  author    = {Amet, Consectetur and Elit, Sed and Tempor, Ut},
  title     = {Ut enim ad minim veniam},
  booktitle = {Proceedings of the Conference on Lorem Ipsum},
  year      = {2023},
  pages     = {101--110}
}

@article{consectetur2018,
  author  = {Consectetur, Adipiscing},
  title   = {Quis nostrud exercitation ullamco},
  journal = {Annals of Dolor},
  year    = {2018},
  volume  = {4},
  pages   = {1--19}
}
`;

export const thesis: Template = {
  id: 'thesis',
  name: 'Thesis',
  description: 'Chapters, front matter, appendix, images and a bibliography',
  mainFile: 'main.tex',
  files: [
    { path: 'main.tex', text: main },
    { path: 'settings/preamble.tex', text: preamble },
    { path: 'settings/macros.tex', text: macros },
    { path: 'frontmatter/titlepage.tex', text: titlepage },
    { path: 'frontmatter/abstract.tex', text: abstract },
    { path: 'frontmatter/acknowledgements.tex', text: acknowledgements },
    { path: 'frontmatter/abbreviations.tex', text: abbreviations },
    { path: 'chapters/01-introduction.tex', text: introduction },
    { path: 'chapters/02-background.tex', text: background },
    { path: 'chapters/03-methods.tex', text: methods },
    { path: 'chapters/04-results.tex', text: results },
    { path: 'chapters/05-discussion.tex', text: discussion },
    { path: 'chapters/06-conclusion.tex', text: conclusion },
    { path: 'appendix/A-supplementary.tex', text: appendix },
    { path: 'images/example-figure.png', bytes: exampleFigure },
    { path: 'bibliography/references.bib', text: references },
  ],
};
