/** The project proposal template: sections, a timeline and a budget table, images and a bibliography. */
import { exampleFigure } from './images';
import { lorem, loremLine } from './lorem';
import type { Template } from './types';

const main = String.raw`% Project proposal
%
% How this project is laid out:
%   main.tex            this file: title block and the order of the sections
%   settings/           packages, page layout and the project details
%   sections/           one file per section of the proposal
%   tables/             the timeline and the budget
%   images/             pictures; \includegraphics finds them by name alone
%   bibliography/       references.bib, your library of sources

\documentclass[11pt,a4paper]{article}

\input{settings/preamble}
\input{settings/details}

\begin{document}

\input{sections/00-titlepage}

\input{sections/01-summary}
\input{sections/02-background}
\input{sections/03-objectives}
\input{sections/04-methodology}
\input{sections/05-work-plan}
\input{sections/06-budget}
\input{sections/07-risks}
\input{sections/08-impact}

\bibliographystyle{plainnat}
\bibliography{bibliography/references}

\end{document}
`;

const preamble = String.raw`% Packages and page layout for the proposal.

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage[english]{babel}
\usepackage{microtype}
\usepackage[a4paper,margin=2.5cm]{geometry}
\usepackage[parfill]{parskip}

\usepackage{amsmath}
\usepackage{graphicx}
\graphicspath{{images/}}
\usepackage{booktabs}
\usepackage{tabularx}
\usepackage[font=small,labelfont=bf]{caption}
\usepackage{enumitem}
\usepackage[round,authoryear]{natbib}

% Colours: the accent is used for headings, rules, links and the timeline.
% It is black, so the proposal prints in black and grey. To add colour,
% replace the \colorlet line with, say, \definecolor{accent}{HTML}{17715B}
\usepackage[table]{xcolor}
\colorlet{accent}{black}

% Section headings in the accent colour
\usepackage{titlesec}
\titleformat{\section}{\Large\bfseries\color{accent}}{\thesection}{0.75em}{}
\titleformat{\subsection}{\large\bfseries}{\thesubsection}{0.75em}{}

\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\projectacronym}
\fancyhead[R]{\small\projecttitle}
\fancyfoot[C]{\thepage}

% A filled cell in the timeline, in a lighter shade of the accent
\newcommand{\busy}{\cellcolor{accent!55}}

\usepackage[colorlinks=true,allcolors=accent]{hyperref}
`;

const details = String.raw`% Project details, used on the title block and in the page header.
\newcommand{\projecttitle}{Lorem Ipsum: Dolor Sit Amet for Consectetur Elit}
\newcommand{\projectacronym}{LOREM}
\newcommand{\applicant}{Your Name}
\newcommand{\institution}{Institute of Lorem Ipsum}
\newcommand{\duration}{24 months}
\newcommand{\requestedfunding}{EUR 250{,}000}
`;

const titlepage = String.raw`% The title block at the top of the first page.
\begin{center}
  {\color{accent}\rule{\textwidth}{1.5pt}}\\[0.8em]
  {\small\scshape Project proposal}\\[0.6em]
  {\LARGE\bfseries \projecttitle\par}
  \vspace{0.6em}
  {\large \projectacronym}\\[0.8em]
  {\color{accent}\rule{\textwidth}{0.5pt}}
\end{center}

\begin{tabularx}{\textwidth}{@{}lX@{}}
  \textbf{Applicant} & \applicant, \institution \\
  \textbf{Duration} & \duration \\
  \textbf{Requested funding} & \requestedfunding \\
  \textbf{Date} & \today \\
\end{tabularx}

\vspace{1em}
`;

const summary = String.raw`\section{Summary}
\label{sec:summary}

${lorem(1)}
`;

const background = String.raw`\section{Background and state of the art}
\label{sec:background}

${lorem(1, 1)} Earlier work \citep{ipsum2021, dolor2019} leaves an open question.

\subsection{The gap this project fills}

${lorem(1, 3)}

\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.6\textwidth]{example-figure}
  \caption{Lorem ipsum dolor sit amet. Replace images/example-figure.png with your own picture.}
  \label{fig:concept}
\end{figure}
`;

const objectives = String.raw`\section{Objectives}
\label{sec:objectives}

${lorem(1, 2)} The project has three objectives:

\begin{enumerate}[label=\textbf{O\arabic*}]
  \item ${loremLine(0)}
  \item ${loremLine(6)}
  \item ${loremLine(10)}
\end{enumerate}
`;

const methodology = String.raw`\section{Methodology}
\label{sec:methodology}

${lorem(1, 4)} Figure~\ref{fig:concept} outlines the approach.

\subsection*{Work package 1: Lorem ipsum}
${lorem(1, 5)}

\subsection*{Work package 2: Dolor sit amet}
${lorem(1, 0)}

\subsection*{Work package 3: Consectetur adipiscing}
${lorem(1, 3)} The method follows \citet{amet2023}.
`;

const workPlan = String.raw`\section{Work plan}
\label{sec:work-plan}

Table~\ref{tab:timeline} shows when each work package runs, by quarter.

\input{tables/timeline}
`;

const budgetSection = String.raw`\section{Budget}
\label{sec:budget}

${lorem(1, 1)}

\input{tables/budget}
`;

const risks = String.raw`\section{Risks and mitigation}
\label{sec:risks}

\begin{tabularx}{\textwidth}{@{}Xll@{}}
  \toprule
  Risk & Likelihood & Mitigation \\
  \midrule
  Lorem ipsum dolor sit amet & Low & Sed do eiusmod \\
  Consectetur adipiscing elit & Medium & Ut enim ad minim \\
  Quis nostrud exercitation & Low & Duis aute irure \\
  \bottomrule
\end{tabularx}
`;

const impact = String.raw`\section{Expected outcomes and impact}
\label{sec:impact}

${lorem(1, 2)}

\begin{itemize}
  \item ${loremLine(3)}
  \item ${loremLine(8)}
  \item ${loremLine(13)}
\end{itemize}
`;

const timeline = String.raw`% The timeline: one row per work package, one column per quarter.
% Mark a quarter as active with \busy (defined in settings/preamble.tex).
\begin{table}[htbp]
  \centering
  \caption{Timeline of the work packages by quarter.}
  \label{tab:timeline}
  \setlength{\tabcolsep}{4pt}
  \begin{tabular}{@{}l*{8}{c}@{}}
    \toprule
    & \multicolumn{4}{c}{Year 1} & \multicolumn{4}{c}{Year 2} \\
    \cmidrule(lr){2-5}\cmidrule(lr){6-9}
    Work package & Q1 & Q2 & Q3 & Q4 & Q1 & Q2 & Q3 & Q4 \\
    \midrule
    WP1 Lorem ipsum        & \busy & \busy & \busy &         &         &         &         &         \\
    WP2 Dolor sit amet     &         &         & \busy & \busy & \busy & \busy &         &         \\
    WP3 Consectetur        &         &         &         &         & \busy & \busy & \busy & \busy \\
    Reporting              &         &         &         & \busy &         &         &         & \busy \\
    \bottomrule
  \end{tabular}
\end{table}
`;

const budget = String.raw`% The budget. Amounts in euros.
\begin{table}[htbp]
  \centering
  \caption{Requested budget.}
  \label{tab:budget}
  \begin{tabular}{@{}lrrr@{}}
    \toprule
    Item & Year 1 & Year 2 & Total \\
    \midrule
    Personnel   & 90{,}000 & 95{,}000 & 185{,}000 \\
    Equipment   & 25{,}000 &  5{,}000 &  30{,}000 \\
    Travel      &  6{,}000 &  9{,}000 &  15{,}000 \\
    Consumables & 10{,}000 & 10{,}000 &  20{,}000 \\
    \midrule
    \textbf{Total} & \textbf{131{,}000} & \textbf{119{,}000} & \textbf{250{,}000} \\
    \bottomrule
  \end{tabular}
\end{table}
`;

const references = `% Your library of sources. Cite an entry by its key, for example \\citep{ipsum2021}.
% Only cited entries appear in the references.

@article{ipsum2021,
  author  = {Ipsum, Lorem and Dolor, Sit},
  title   = {Consectetur adipiscing elit sed do eiusmod},
  journal = {Journal of Lorem Ipsum},
  year    = {2021},
  volume  = {12},
  pages   = {45--67}
}

@book{dolor2019,
  author    = {Dolor, Amet},
  title     = {Tempor Incididunt ut Labore},
  publisher = {Magna Aliqua Press},
  year      = {2019}
}

@inproceedings{amet2023,
  author    = {Amet, Consectetur and Elit, Sed},
  title     = {Ut enim ad minim veniam},
  booktitle = {Proceedings of the Conference on Lorem Ipsum},
  year      = {2023},
  pages     = {101--110}
}
`;

export const proposal: Template = {
  id: 'proposal',
  name: 'Project Proposal',
  description: 'Objectives, work plan, budget, images and a bibliography',
  mainFile: 'main.tex',
  files: [
    { path: 'main.tex', text: main },
    { path: 'settings/preamble.tex', text: preamble },
    { path: 'settings/details.tex', text: details },
    { path: 'sections/00-titlepage.tex', text: titlepage },
    { path: 'sections/01-summary.tex', text: summary },
    { path: 'sections/02-background.tex', text: background },
    { path: 'sections/03-objectives.tex', text: objectives },
    { path: 'sections/04-methodology.tex', text: methodology },
    { path: 'sections/05-work-plan.tex', text: workPlan },
    { path: 'sections/06-budget.tex', text: budgetSection },
    { path: 'sections/07-risks.tex', text: risks },
    { path: 'sections/08-impact.tex', text: impact },
    { path: 'tables/timeline.tex', text: timeline },
    { path: 'tables/budget.tex', text: budget },
    { path: 'images/example-figure.png', bytes: exampleFigure },
    { path: 'bibliography/references.bib', text: references },
  ],
};
