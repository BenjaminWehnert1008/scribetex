/** The CV template: a one-column CV with a photo, sections in their own files and publications from a .bib file. */
import { photoPlaceholder } from './images';
import type { Template } from './types';

const main = String.raw`% Curriculum vitae
%
% How this project is laid out:
%   main.tex            this file: the header and the order of the sections
%   settings/           the look of the CV and the \cventry command
%   sections/           one file per section; drop a line here to leave one out
%   images/             photo.png, your photo (or delete the photo line below)
%   bibliography/       publications.bib, every entry in it is listed

\documentclass[11pt,a4paper]{article}

\input{settings/cv-style}

\begin{document}

% Header: name, contact details and photo
\begin{minipage}[c]{0.72\textwidth}
  {\Huge\bfseries Your Name}\\[0.4em]
  {\Large\color{accent} Lorem Ipsum Specialist}\\[0.8em]
  \small
  Lorem Street 1, 12345 Ipsum \\
  +00 123 456 789 \quad
  \href{mailto:your.name@example.com}{your.name@example.com} \\
  \href{https://example.com}{example.com} \quad
  \href{https://github.com/your-name}{github.com/your-name}
\end{minipage}%
\hfill
\begin{minipage}[c]{0.22\textwidth}
  \raggedleft
  \includegraphics[width=\linewidth]{photo}
\end{minipage}

\input{sections/profile}
\input{sections/experience}
\input{sections/education}
\input{sections/skills}
\input{sections/languages}

% Publications: every entry in bibliography/publications.bib, in the style "plain"
\nocite{*}
\bibliographystyle{plain}
\bibliography{bibliography/publications}

\end{document}
`;

const style = String.raw`% The look of the CV.

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\renewcommand{\familydefault}{\sfdefault}
\usepackage[english]{babel}
\usepackage{microtype}
\usepackage[a4paper,margin=2cm]{geometry}
\usepackage{graphicx}
\graphicspath{{images/}}
\usepackage{tabularx}
\usepackage{enumitem}
\setlist[itemize]{leftmargin=1.2em,topsep=2pt,itemsep=1pt}

\usepackage{xcolor}
\definecolor{accent}{HTML}{17715B}
\definecolor{muted}{HTML}{6B665A}

% Section headings: accent colour, with a thin rule underneath
\usepackage{titlesec}
\titleformat{\section}{\Large\bfseries\color{accent}}{}{0pt}{}[{\color{accent}\titlerule[0.6pt]}]
\titlespacing*{\section}{0pt}{1.2em}{0.6em}

\pagestyle{empty}
\setlength{\parindent}{0pt}

% The publications list is headed "Publications" (babel sets the name, so tell babel)
\addto\captionsenglish{\renewcommand{\refname}{Publications}}

% \cventry{dates}{title}{place}{description}
% Leave the description empty ({}) for a one-line entry.
\newcommand{\cventry}[4]{%
  \begin{tabularx}{\textwidth}{@{}p{0.2\textwidth}X@{}}
    \textcolor{muted}{#1} & \textbf{#2}\hfill{\itshape #3}
  \end{tabularx}\par
  \if\relax\detokenize{#4}\relax\else
    \hspace*{0.2\textwidth}\hspace{-0.5pt}%
    \begin{minipage}[t]{0.8\textwidth}\small #4\end{minipage}\par
  \fi
  \vspace{0.6em}%
}

% \cvitem{label}{text}, for skills and languages
\newcommand{\cvitem}[2]{%
  \begin{tabularx}{\textwidth}{@{}p{0.2\textwidth}X@{}}
    \textcolor{muted}{#1} & #2
  \end{tabularx}\par\vspace{0.2em}%
}

\usepackage[colorlinks=true,urlcolor=accent,linkcolor=accent,citecolor=accent]{hyperref}
`;

const profile = String.raw`\section{Profile}

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et
dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
`;

const experience = String.raw`\section{Experience}

\cventry{2023 -- today}{Senior Lorem Ipsum Engineer}{Dolor Sit GmbH, Amet}{
  \begin{itemize}
    \item Consectetur adipiscing elit, sed do eiusmod tempor incididunt.
    \item Ut enim ad minim veniam, quis nostrud exercitation ullamco.
  \end{itemize}
}

\cventry{2020 -- 2023}{Lorem Ipsum Engineer}{Consectetur Labs, Elit}{
  \begin{itemize}
    \item Duis aute irure dolor in reprehenderit in voluptate velit.
    \item Excepteur sint occaecat cupidatat non proident.
  \end{itemize}
}

\cventry{2019}{Intern}{Magna Aliqua Ltd., Tempor}{}
`;

const education = String.raw`\section{Education}

\cventry{2018 -- 2020}{M.Sc.\ Lorem Ipsum}{University of Dolor}{Thesis: \emph{Consectetur adipiscing elit sed do eiusmod}. Grade: 1.3}

\cventry{2015 -- 2018}{B.Sc.\ Lorem Ipsum}{University of Amet}{}
`;

const skills = String.raw`\section{Skills}

\cvitem{Lorem}{Ipsum, Dolor, Sit, Amet}
\cvitem{Consectetur}{Adipiscing, Elit, Sed do eiusmod}
\cvitem{Tools}{\LaTeX, Lorem, Ipsum}
`;

const languages = String.raw`\section{Languages}

\cvitem{Lorem}{Native}
\cvitem{Ipsum}{Fluent (C1)}
\cvitem{Dolor}{Basic (A2)}
`;

const publications = `% Your publications. Every entry here is listed on the CV (\\nocite{*} in main.tex).

@article{name2024,
  author  = {Name, Your and Ipsum, Lorem},
  title   = {Consectetur adipiscing elit sed do eiusmod},
  journal = {Journal of Lorem Ipsum},
  year    = {2024},
  volume  = {15},
  pages   = {1--12}
}

@inproceedings{name2022,
  author    = {Dolor, Sit and Name, Your},
  title     = {Ut enim ad minim veniam},
  booktitle = {Proceedings of the Conference on Lorem Ipsum},
  year      = {2022},
  pages     = {33--40}
}
`;

export const cv: Template = {
  id: 'cv',
  name: 'CV',
  description: 'A one-page CV with photo, sections and publications',
  mainFile: 'main.tex',
  files: [
    { path: 'main.tex', text: main },
    { path: 'settings/cv-style.tex', text: style },
    { path: 'sections/profile.tex', text: profile },
    { path: 'sections/experience.tex', text: experience },
    { path: 'sections/education.tex', text: education },
    { path: 'sections/skills.tex', text: skills },
    { path: 'sections/languages.tex', text: languages },
    { path: 'images/photo.png', bytes: photoPlaceholder },
    { path: 'bibliography/publications.bib', text: publications },
  ],
};
