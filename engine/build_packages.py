#!/usr/bin/env python3
"""Build the static package folder that the compile engine loads LaTeX packages from.

The engine's package loader only ever does plain GET requests:
    GET <base>/api/texlive/<package>              one archive per TeX Live package (.tar.xz, no extension)
    GET <base>/bundles/file-to-package.json       which package provides which file
so a folder of pre-built archives on a static host is enough. No server is involved.

usage: build_packages.py <texlive-root> <out-dir> <runtime-dir> [--only a,b,c]

Every archive mimics a TeX Live network container: paths are relative to
texmf-dist (tex/..., fonts/..., bibtex/...). Package files are copied unchanged.
A MANIFEST.tsv lists every package with its TeX Live revision and licence.
"""
import io
import json
import lzma
import os
import shutil
import sys
import tarfile

KEEP = ('texmf-dist/tex/', 'texmf-dist/fonts/', 'texmf-dist/bibtex/', 'texmf-dist/makeindex/')
SKIP_SUFFIXES = ('x86_64-linux', 'aarch64-linux', 'universal-darwin', 'windows', 'infra')
# Files that TeX, BibTeX, biblatex and pdfTeX's font map ask for by name. The
# engine finds the package of a missing file in bundles/file-to-package.json,
# which comes with the runtime and lists macro files, but no bibliography or
# biblatex styles and no encoding files. A style that no .sty brings along,
# like apalike2.bst, or an encoding file that another package's fonts use,
# like ntx-ec-tlf.enc (newtx) for newpx, so had no package to fetch. These
# files of the hosted packages are added to that index.
BY_NAME = ('.sty', '.cls', '.def', '.fd', '.cfg', '.clo', '.ldf', '.tex', '.bst', '.bbx', '.cbx', '.lbx', '.dbx', '.enc')


def parse_tlpdb(path):
    """Parse texlive.tlpdb into {name: {'runfiles': [...], 'revision': str, 'catalogue-license': str}}."""
    pkgs = {}
    cur = None
    section = None
    with open(path, encoding='utf-8', errors='replace') as handle:
        for line in handle:
            line = line.rstrip('\n')
            if not line.strip():
                cur = None
                section = None
                continue
            if line.startswith('name '):
                cur = {'name': line[5:].strip(), 'runfiles': [], 'revision': '', 'catalogue-license': '', 'shortdesc': ''}
                pkgs[cur['name']] = cur
                section = None
                continue
            if cur is None:
                continue
            if line.startswith(' '):
                if section == 'runfiles':
                    cur['runfiles'].append(line.strip().split(' ')[0])
                continue
            key, _, val = line.partition(' ')
            section = key if key in ('runfiles', 'docfiles', 'srcfiles', 'binfiles') else None
            if key in ('revision', 'catalogue-license', 'shortdesc'):
                cur[key] = val.strip()
    return pkgs


def index_hosted_files(out, runtime, hosted):
    """Adds the files of the hosted packages that are asked for by name to the file index (see BY_NAME)."""
    path = os.path.join(out, 'bundles', 'file-to-package.json')
    with open(path, encoding='utf-8') as handle:
        files = json.load(handle)
    # A file in the runtime bundles is found without fetching a package.
    with open(os.path.join(runtime, 'file-manifest.json'), encoding='utf-8') as handle:
        bundled = {entry.rsplit('/', 1)[-1] for entry in json.load(handle)}
    added = 0
    for name, paths in hosted:
        for entry in paths:
            base = entry.rsplit('/', 1)[-1]
            if base.endswith(BY_NAME) and base not in files and base not in bundled:
                files[base] = name
                added += 1
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(files, handle)
    return added


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    root, out, runtime = sys.argv[1], sys.argv[2], sys.argv[3]
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))

    pkgs = parse_tlpdb(os.path.join(root, 'tlpkg', 'texlive.tlpdb'))
    api = os.path.join(out, 'api', 'texlive')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(api)
    os.makedirs(os.path.join(out, 'bundles'))

    index = []
    hosted = []
    for name, pkg in sorted(pkgs.items()):
        if only and name not in only:
            continue
        if name.startswith('00texlive') or ('.' in name and name.rsplit('.', 1)[1] in SKIP_SUFFIXES):
            continue
        files = [f for f in pkg['runfiles'] if f.startswith(KEEP) and os.path.isfile(os.path.join(root, f))]
        if not files:
            continue
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for f in sorted(files):
                with open(os.path.join(root, f), 'rb') as src:
                    data = src.read()
                info = tarfile.TarInfo(f[len('texmf-dist/'):])
                info.size = len(data)
                info.mode = 0o644
                info.mtime = 0
                tar.addfile(info, io.BytesIO(data))
        packed = lzma.compress(raw.getvalue(), format=lzma.FORMAT_XZ, preset=6)
        # No file extension: the engine requests /api/texlive/<name>.
        with open(os.path.join(api, name), 'wb') as dst:
            dst.write(packed)
        hosted.append((name, files))
        index.append({
            'name': name,
            'revision': pkg['revision'],
            'files': len(files),
            'bytes': len(packed),
            'license': pkg['catalogue-license'] or 'see ctan.org/pkg/' + name,
        })

    for name in ('file-to-package.json', 'font-name-to-package.json'):
        shutil.copyfile(os.path.join(runtime, name), os.path.join(out, 'bundles', name))
    added = index_hosted_files(out, runtime, hosted)
    print(f'file index: {added} files of the hosted packages added')
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as handle:
        json.dump(index, handle, indent=1)
    with open(os.path.join(out, 'MANIFEST.tsv'), 'w', encoding='utf-8') as handle:
        handle.write('package\ttexlive-revision\tfiles\tbytes\tlicence\tctan\n')
        for item in index:
            handle.write(f"{item['name']}\t{item['revision']}\t{item['files']}\t{item['bytes']}\t{item['license']}\thttps://ctan.org/pkg/{item['name']}\n")

    total = sum(item['bytes'] for item in index) / 1048576
    print(f'packages: {len(index)}, {total:.1f} MB compressed')


if __name__ == '__main__':
    main()
