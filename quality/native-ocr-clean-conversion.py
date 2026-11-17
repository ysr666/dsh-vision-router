"""Reacquire public inputs and reproduce the pinned PP-OCRv6 model bytes.
Windows x64 only. No upload, installation, private test images or release.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request
import zipfile

REPO = Path(__file__).resolve().parent.parent
LEDGER = json.loads((REPO / 'quality/native-ocr-provenance-LAB.json').read_text())
WHEEL = {
    'url': 'https://files.pythonhosted.org/packages/e8/51/1b30523f85f9482f55f3f4f11ad8f4a37db7c8773d66625cceb2973c5c60/pnnx-20261020-py3-none-win_amd64.whl',
    'bytes': 18662314,
    'sha256': 'cde5381cdebbef5d3e0e796e824ed02e2e1dfd075731921a3b3653514c518309',
}

def identity(path):
    with path.open('rb') as source:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(source, 'sha256').hexdigest()}

def verify(path, expected):
    actual = identity(path)
    if any(actual[k] != expected[k] for k in ('bytes', 'sha256') if k in expected):
        raise RuntimeError(f'IDENTITY_MISMATCH: {path.name}: {actual}')
    return actual

def acquire(url, dest, expected):
    request = urllib.request.Request(url, headers={'User-Agent': 'DVR-native-OCR-clean-audit/1'})
    with urllib.request.urlopen(request, timeout=60) as response, dest.open('xb') as output:
        if not response.geturl().startswith('https://'):
            raise RuntimeError('NON_HTTPS_SOURCE')
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > expected['bytes']:
                raise RuntimeError('SOURCE_SIZE_EXCEEDED')
            output.write(chunk)
    return verify(dest, expected)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work-dir', required=True, type=Path)
    args = parser.parse_args()
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('WINDOWS_X64_REQUIRED')
    root = args.work_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    models = root / 'models'
    models.mkdir()
    wheel = root / 'converter.whl'
    wheel_id = acquire(WHEEL['url'], wheel, WHEEL)
    exe = root / 'pnnx.exe'
    with zipfile.ZipFile(wheel) as archive:
        candidates = [item for item in archive.infolist()
                      if item.filename.replace('\\', '/').split('/')[-1].lower() == 'pnnx.exe']
        if len(candidates) != 1 or candidates[0].file_size > 160 * 1024 * 1024:
            raise RuntimeError('INVALID_CONVERTER_MEMBER')
        with archive.open(candidates[0]) as source, exe.open('xb') as dest:
            shutil.copyfileobj(source, dest)
    exe_id = verify(exe, {'sha256': LEDGER['conversionReproduction']['standaloneWindowsExeSha256']})
    report = {'sourceCommit': subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
              'environment': platform.platform(), 'converterWheel': wheel_id, 'converterExe': exe_id,
              'inputs': {}, 'outputs': {}, 'distributionReady': False}
    for key, name in [('detector', 'det'), ('recognizer', 'rec')]:
        row = LEDGER['modelSources'][key]
        target = root / name
        target.mkdir()
        onnx = target / 'inference.onnx'
        report['inputs'][key] = acquire(
            f"https://huggingface.co/{row['source']}/resolve/{row['revision']}/{row['file']}", onnx, row)
        command = [str(exe), 'inference.onnx', *LEDGER['conversionReproduction'][key + 'Args']]
        with (target / 'conversion.log').open('w', encoding='utf-8') as log:
            subprocess.run(command, cwd=target, stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=240)
        for suffix in ('bin', 'param'):
            output_name = f'{name}.ncnn.{suffix}'
            source = target / f'inference.ncnn.{suffix}'
            dest = models / output_name
            shutil.copyfile(source, dest)
            report['outputs'][output_name] = verify(dest, LEDGER['nativeAssets'][output_name])
    row = LEDGER['dictionary']
    name = 'ppocrv6_dict.txt'
    report['outputs'][name] = acquire(
        f"https://raw.githubusercontent.com/{row['source']}/{row['revision']}/{row['file']}",
        models / name, row)
    report['allFiveAssetsMatch'] = True
    (root / 'conversion-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
    print('CLEAN_MODEL_CONVERSION_MATCH 5/5 (candidate evidence only; no distribution clearance)')

if __name__ == '__main__':
    main()
