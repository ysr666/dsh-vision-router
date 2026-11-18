"""Read-only identity check for the two exact privately tested native OCR packages.
Never extracts files, executes a worker, changes pins, or approves redistribution.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile

MAX_MEMBER = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
PREFIX = 'ppocrv6-small/'
MODEL_NAMES = {'det.ncnn.bin', 'det.ncnn.param', 'rec.ncnn.bin', 'rec.ncnn.param', 'ppocrv6_dict.txt'}
BASE_NOTICES = {
    'NCNN-LICENSE.txt': 'assets/licenses/ncnn-LICENSE.txt',
    'APACHE-2.0.txt': 'assets/licenses/apache-2.0.txt',
    'PADDLEOCR-LICENSE.txt': 'assets/licenses/paddleocr-LICENSE.txt',
    'PROJECT-LICENSE.txt': 'LICENSE',
}
WIN_NOTICES = {
    'LLVM-LICENSE.txt': 'assets/licenses/llvm-mingw-LICENSE.txt',
    'MINGW-RUNTIME-COPYING.txt': 'assets/licenses/mingw-w64-runtime-COPYING.txt',
    'MINGW-SOURCE-NOTICES.txt': 'assets/licenses/mingw-w64-source-NOTICES.txt',
    'WINDOWS-RUNTIME-NOTICES.txt': 'assets/licenses/windows-native-runtime-NOTICES.txt',
    'MINGW-PTHREAD-SIGNAL-NOTICE.txt': 'assets/licenses/mingw-pthread-signal-NOTICE.txt',
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_unique(data):
    def pairs(rows):
        out = {}
        for key, value in rows:
            require(key not in out, 'DUPLICATE_JSON_KEY: ' + key)
            out[key] = value
        return out
    return json.loads(data, object_pairs_hook=pairs)


def verify(path, target, ledger, provenance, notices):
    require(target in ('darwin-arm64', 'win32-x64'), 'UNSUPPORTED_TARGET')
    require(ledger['distributionReady'] is False and not any(ledger['gates'].values()), 'UNEXPECTED_GATE_PROMOTION')
    entry = ledger['platforms'][target]
    require(path.name == entry['archive'] and path.is_file() and not path.is_symlink(), 'ARCHIVE_NAME_OR_TYPE')
    require(path.stat().st_size == entry['bytes'] and 0 < entry['bytes'] <= 64 * 1024 * 1024, 'ARCHIVE_SIZE_MISMATCH')
    # Hash and parse from one open stream; no extraction or execution.
    with path.open('rb') as stream:
        require(hashlib.file_digest(stream, 'sha256').hexdigest() == entry['sha256'], 'ARCHIVE_SHA_MISMATCH')
        stream.seek(0)
        models = provenance['nativeAssets']
        require(set(models) == MODEL_NAMES, 'MODEL_LEDGER_MISMATCH')
        platform, arch = target.split('-')
        worker = 'worker.exe' if platform == 'win32' else 'worker'
        expected = {worker, 'MANIFEST.json', 'SBOM.cdx.json', 'SOURCE-NOTICE.md'} | set(notices) | {'models/' + n for n in models}
        require(len(expected) == entry['memberCount'], 'MEMBER_COUNT_LEDGER_MISMATCH')
        facts, json_files = {}, {}
        total = 0
        with tarfile.open(fileobj=stream, mode='r:gz') as archive:
            for info in archive:
                require(info.name.startswith(PREFIX), 'UNEXPECTED_MEMBER_PREFIX')
                name = info.name[len(PREFIX):]
                require(name in expected and name not in facts, 'UNEXPECTED_OR_DUPLICATE_MEMBER: ' + name)
                require(info.isfile() and not info.issparse() and not info.pax_headers, 'UNEXPECTED_MEMBER_TYPE: ' + name)
                total += info.size
                require(0 <= info.size <= MAX_MEMBER and total <= MAX_TOTAL, 'MEMBER_SIZE_LIMIT')
                payload = archive.extractfile(info)
                require(payload is not None, 'MISSING_MEMBER_DATA')
                with payload:
                    data = payload.read(MAX_MEMBER + 1)
                require(len(data) == info.size, 'SHORT_MEMBER: ' + name)
                facts[name] = {'bytes': len(data), 'sha256': sha(data)}
                if name in ('MANIFEST.json', 'SBOM.cdx.json'):
                    require(len(data) <= 256 * 1024, 'METADATA_SIZE_LIMIT')
                    json_files[name] = json_unique(data)
        require(set(facts) == expected, 'MISSING_MEMBER')
    require(facts[worker]['sha256'] == entry['workerSha256'], 'WORKER_SHA_MISMATCH')
    for name, value in models.items():
        require(facts['models/' + name] == value, 'MODEL_SHA_OR_SIZE_MISMATCH: ' + name)
    for name, expected_sha in notices.items():
        require(facts[name]['sha256'] == expected_sha, 'NOTICE_SHA_MISMATCH: ' + name)
    manifest = json_files['MANIFEST.json']
    require(manifest['schemaVersion'] == entry['manifestSchema'] and manifest['platform'] == platform and manifest['arch'] == arch, 'MANIFEST_TARGET_OR_SCHEMA')
    require(manifest['distributionReady'] is False and manifest['worker'] == facts[worker] and manifest['models'] == models, 'MANIFEST_IDENTITY_OR_GATE')
    require(manifest['files'] == {k: v for k, v in facts.items() if k != 'MANIFEST.json'}, 'MANIFEST_MEMBER_INVENTORY')
    sbom = json_files['SBOM.cdx.json']
    require(sbom['bomFormat'] == 'CycloneDX' and sbom['specVersion'] == '1.6', 'SBOM_FORMAT')
    require(sbom['metadata']['component']['hashes'] == [{'alg': 'SHA-256', 'content': entry['workerSha256']}], 'SBOM_WORKER_IDENTITY')
    require(sbom['metadata']['properties'].count({'name': 'dvr:distribution-ready', 'value': 'false'}) == 1, 'SBOM_GATE')
    require(sbom['compositions'] == [{'aggregate': 'incomplete', 'assemblies': ['worker']}], 'SBOM_SCOPE')
    return {'target': target, 'archiveSha256': entry['sha256'], 'workerSha256': entry['workerSha256'], 'members': len(facts), 'identityVerified': True, 'distributionReady': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=['darwin-arm64', 'win32-x64'])
    parser.add_argument('--archive', required=True, type=Path)
    a = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    ledger = json_unique((root / 'quality/native-ocr-delivery-candidates.json').read_bytes())
    provenance = json_unique((root / 'quality/native-ocr-provenance-LAB.json').read_bytes())
    notice_paths = dict(BASE_NOTICES)
    if a.target == 'win32-x64':
        notice_paths.update(WIN_NOTICES)
    notices = {name: sha((root / path).read_bytes()) for name, path in notice_paths.items()}
    print(json.dumps(verify(a.archive, a.target, ledger, provenance, notices), indent=2))


if __name__ == '__main__':
    main()
