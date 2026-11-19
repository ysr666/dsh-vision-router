#!/usr/bin/env python3
"""Read-only COFF comparison when excluding transitive WIDL headers from CRT C.

This reproduces the exact 10 CRT objects that included msxml.h in the accepted
Windows candidate, compiles a variant with WIN32_LEAN_AND_MEAN, compares all
non-debug COFF sections and their relocations, and reports their include lists.
Never replaces the candidate, marks distribution ready, or uploads object bytes.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

MSXML = 'toolchain/generic-w64-mingw32/include/msxml.h'
REVISION = '0d6dfbc348dfad714761c0a7151615767f96bcb5'
TOOL_NAME = 'llvm-mingw-20261020-ucrt-macos-universal'
TOKENS = {'@SOURCE@': 'source', '@TOOL@': 'tool', '@BUILD@': 'build',
          '@OVERLAY@': 'overlay', '@OUTPUT@': 'out', '@DEPFILE@': 'dep'}


def need(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def select_rows(evidence: dict, recipe: dict) -> list[dict]:
    need(evidence.get('sourceRevision') == REVISION and
         evidence.get('exactStrippedObjectReplayMatches') == 68 and
         evidence.get('distributionReady') is False, 'WRONG_ORIGIN_EVIDENCE')
    need(recipe.get('sourceRevision') == REVISION and recipe.get('schemaVersion') == 1
         and recipe.get('distributionReady') is False, 'WRONG_COMPILE_RECIPE')
    per = evidence.get('perObject')
    rows = recipe.get('recipes')
    need(isinstance(per, dict) and len(per) == 68 and
         isinstance(rows, list) and len(rows) == 68, 'INCOMPLETE_CRT_OBJECTS')
    matched = []
    seen = set()
    for row in rows:
        key = row['archive'] + '/' + row['member']
        need(key in per and key not in seen and row.get('normalizedSha256') == per[key]['normalizedSha256'],
             'WRONG_OBJECT_RECIPE: ' + key)
        seen.add(key)
        if MSXML in per[key]['dependencies']:
            matched.append(row)
    need(len(seen) == 68 and len(matched) == 10, 'UNEXPECTED_MSXML_OBJECT_COUNT')
    return matched


def substitute(args: list, values: dict) -> list[str]:
    need(isinstance(args, list) and all(isinstance(x, str) for x in args),
         'MALFORMED_COMPILE_ARGS')
    result = []
    for value in args:
        for token, key in TOKENS.items():
            value = value.replace(token, str(values[key]))
        need(not re.search(r'@[A-Z_]+@', value), 'UNRESOLVED_COMPILE_TOKEN')
        result.append(value)
    need('-c' in result and '-o' in result and '-MF' in result,
         'UNEXPECTED_COMPILE_ARGS')
    need(result[result.index('-o') + 1] == str(values['out']) and
         result[result.index('-MF') + 1] == str(values['dep']),
         'UNEXPECTED_OUTPUT_BINDINGS')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lab', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    root, repo = args.lab.resolve(strict=True), args.repo.resolve(strict=True)
    need(not args.report.exists(), 'EXISTING_REPORT')
    spec = importlib.util.spec_from_file_location('crt', repo / 'quality/native-ocr-crt-reconstruct-LAB.py')
    crt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(crt)
    evidence = json.loads((root/'crt-reconstruction-evidence.json').read_text())
    recipe = json.loads((root/'crt-portable-source-recipe.json').read_text())
    rows = select_rows(evidence, recipe)
    source, tool = root/('mingw-w64-'+REVISION), root/TOOL_NAME
    build, overlay = root/'build-x86_64', root/'llvm-stdarg-vfs.json'
    need(source.is_dir() and tool.is_dir() and build.is_dir() and overlay.is_file(),
         'MISSING_EXACT_CRT_REPLAY_INPUTS')
    lab = root/'widl-lean-differential'
    lab.mkdir(mode=0o700)
    compiler = tool/'bin/x86_64-w64-mingw32-gcc'
    env = dict(os.environ, PATH=str(tool/'bin') + ':/opt/homebrew/bin:/usr/bin:/bin',
               LC_ALL='C', SOURCE_DATE_EPOCH='1794700800')
    for key in ('SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CXX',
                'CFLAGS', 'CPPFLAGS', 'LDFLAGS'):
        env.pop(key, None)
    details = []
    for row in rows:
        key = row['archive']+'/'+row['member']
        original = root/'replacement-objects'/row['target']
        need(original.is_file() and crt.normalized_coff(original.read_bytes()) ==
             row['normalizedSha256'], 'BASELINE_OBJECT_MISMATCH: '+key)
        out = lab/row['target']
        out.parent.mkdir(parents=True, exist_ok=True)
        dep = out.with_suffix('.d')
        flags = substitute(row['args'], {
            'source': source, 'tool': tool, 'build': build,
            'overlay': overlay, 'out': out, 'dep': dep
        })
        need('-DWIN32_LEAN_AND_MEAN' not in flags and '-UWIN32_LEAN_AND_MEAN' not in flags,
             'PREEXISTING_LEAN_FLAG')
        command = [str(compiler), '-DWIN32_LEAN_AND_MEAN', *flags]
        item = {'archive': row['archive'], 'member': row['member'],
                'source': row['source'], 'baselineNonDebugCoffSha256': row['normalizedSha256'],
                'additionalFlags': ['-DWIN32_LEAN_AND_MEAN'], 'compileSucceeded': False,
                'nonDebugCoffEquivalent': False, 'msxmlHeaderExcluded': False}
        try:
            proc = subprocess.run(command, cwd=build, env=env, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=90, check=False)
            item['compileSucceeded'] = proc.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            item['compileSucceeded'] = False
        if item['compileSucceeded'] and out.is_file() and dep.is_file():
            # Dependency audit still checks exact pinned inputs and rejects
            # symlink escapes or any previously unreviewed source warnings.
            names = crt.dependencies(dep, build, [
                (tool.resolve(), 'toolchain'), (source.resolve(), 'source'),
                (build.resolve(), 'build'), (root.resolve(), 'private-overlay')
            ])
            alternate = crt.normalized_coff(out.read_bytes())
            item['variantNonDebugCoffSha256'] = alternate
            item['nonDebugCoffEquivalent'] = alternate == row['normalizedSha256']
            item['msxmlHeaderExcluded'] = MSXML not in names
            item['originalDependencyCount'] = len(evidence['perObject'][key]['dependencies'])
            item['variantDependencyCount'] = len(names)
        details.append(item)
    total = len(details)
    report = {
        'schemaVersion': 1, 'scope': 'Read-only differential compilation of ten pinned CRT objects with and without WIN32_LEAN_AND_MEAN, comparing all non-debug COFF sections and relocations',
        'candidateWorkerUntouched': True, 'sourceRevision': REVISION,
        'baselineReconstructedObjects': 68, 'msxmlDependentCrtObjects': total,
        'variantsCompiled': sum(x['compileSucceeded'] for x in details),
        'variantsWithoutMsxmlHeader': sum(x['msxmlHeaderExcluded'] for x in details),
        'nonDebugCoffEquivalentCount': sum(x['nonDebugCoffEquivalent'] for x in details),
        'codeEquivalenceExperimentPassed': all(x['compileSucceeded'] and
            x['msxmlHeaderExcluded'] and x['nonDebugCoffEquivalent'] for x in details),
        'objects': details,
        'limitations': [
            'Equivalent non-debug COFF sections and relocations strengthen absence-of-retained-implementation evidence, but do not constitute a legal opinion.',
            'If an alternate compile fails or differs, no equivalence or license conclusion is inferred.',
            'The experiment covers only the ten exact MinGW CRT translation units including msxml.h, not all ncnn/LLVM and platform SDK code.',
            'No minimum-OS execution or real public HTTPS distribution is tested.',
        ],
        'humanLicenseReviewRequired': True, 'distributionReady': False,
        'ownerPublicationAuthorized': False
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True)+'\n', encoding='utf-8')
    print('WIDL_LEAN_COFF_DIFFERENTIAL', report['variantsCompiled'], '/', total,
          'no_msxml', report['variantsWithoutMsxmlHeader'],
          'equivalent', report['nonDebugCoffEquivalentCount'],
          'distributionReady=false', flush=True)


if __name__ == '__main__':
    main()
