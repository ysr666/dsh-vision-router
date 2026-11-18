"""Read-only identity check for historical and actual staged native OCR packages.
Never extracts files, executes a worker, changes pins, or approves redistribution.
A staged report supplies an observed archive digest, not a production approval.
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


STAGED_WORKERS = {
    'darwin-arm64': '56499298089bc98709d3b6818fc870c8cf16c4c8607edd5ded842f304cbe84de',
    'win32-x64': 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166',
}
MAC_REPLAY_SHA = 'a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd'
INDEPENDENT_CRT_PROPERTIES = {
    'dvr:crt-remediation-evidence-sha256': 'b10a66e205a299770237b042c20a5df2b49a3b5d5100c8b1eb0f12a68ca4a331',
    'dvr:crt-replacement-archive-sha256': '4352197dadef779a8a6cc5cff0126a31d9f5968c43a09f273aa9fdd58f1dcf24',
}


def staged_ledger(target, report):
    require(target in STAGED_WORKERS and report['target'] == target, 'STAGE_TARGET')
    require(report['schemaVersion'] == 1 and report['workerSha256'] == STAGED_WORKERS[target], 'STAGE_WORKER_IDENTITY')
    require(report['archiveReplayMatch'] is True and report['modelOrigin'] == 'windows-canonical', 'STAGE_REPLAY_OR_MODEL_ORIGIN')
    for gate in ('distributionReady', 'ownerPublicationAuthorized', 'exactArchiveDesktopGuiVerified', 'minimumOsRuntimeVerified'):
        require(report[gate] is False, 'STAGE_UNEXPECTED_GATE: ' + gate)
    win = target == 'win32-x64'
    entry = report['archive']
    require(entry['name'] == 'ppocrv6-small-' + target + '.tar.gz' and
            type(entry['bytes']) is int and 128 <= entry['bytes'] <= 64 * 1024 * 1024 and
            re.fullmatch(r'[0-9a-f]{64}', entry['sha256']), 'STAGE_ARCHIVE_IDENTITY')
    require(win or (entry['sha256'] == MAC_REPLAY_SHA and entry['bytes'] == 27917268), 'STAGE_MAC_REPLAY_IDENTITY')
    require(report['members'] == (18 if win else 13), 'STAGE_MEMBER_COUNT')
    require(report['manifest']['worker']['sha256'] == STAGED_WORKERS[target] and
            report['manifest']['distributionReady'] is False, 'STAGE_MANIFEST_IDENTITY')
    require(re.fullmatch(r'[0-9a-f]{64}', report['sbomSha256']), 'STAGE_SBOM_IDENTITY')
    return {'distributionReady': False, 'gates': {'ownerPublicationAuthorized': False},
            'platforms': {target: {'archive': entry['name'], 'bytes': entry['bytes'],
                                   'sha256': entry['sha256'], 'workerSha256': STAGED_WORKERS[target],
                                   'manifestSchema': 4 if win else 3, 'memberCount': 18 if win else 13}}}


def verify(path, target, ledger, provenance, notices, *, stage=None):
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
    result = {'target': target, 'archiveSha256': entry['sha256'], 'workerSha256': entry['workerSha256'], 'members': len(facts), 'identityVerified': True, 'distributionReady': False}
    if stage is not None:
        require(manifest == stage['manifest'] and facts['SBOM.cdx.json']['sha256'] == stage['sbomSha256'], 'STAGE_METADATA_READBACK')
        if target == 'win32-x64':
            mingw = [c for c in sbom.get('components', []) if c.get('bom-ref') == 'mingw']
            require(len(mingw) == 1, 'STAGE_CRT_COMPONENT')
            for name, expected_value in INDEPENDENT_CRT_PROPERTIES.items():
                values = [p.get('value') for p in mingw[0].get('properties', []) if p.get('name') == name]
                require(values == [expected_value], 'STAGE_CRT_EVIDENCE: ' + name)
        result.update(archiveBytes=entry['bytes'], sbomSha256=facts['SBOM.cdx.json']['sha256'],
                      stagedMetadataReadback=True, independentTarReader=True,
                      distributionReviewComplete=False, ownerPublicationAuthorized=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=['darwin-arm64', 'win32-x64'])
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--staging-evidence', type=Path)
    parser.add_argument('--report', type=Path)
    a = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    stage = None
    if a.staging_evidence is not None:
        require(a.staging_evidence.is_file() and not a.staging_evidence.is_symlink() and
                a.staging_evidence.stat().st_size <= 256 * 1024, 'STAGE_REPORT_TYPE_OR_SIZE')
        stage = json_unique(a.staging_evidence.read_bytes())
        ledger = staged_ledger(a.target, stage)
    else:
        ledger = json_unique((root / 'quality/native-ocr-delivery-candidates.json').read_bytes())
    provenance = json_unique((root / 'quality/native-ocr-provenance-LAB.json').read_bytes())
    notice_paths = dict(BASE_NOTICES)
    if a.target == 'win32-x64':
        notice_paths.update(WIN_NOTICES)
    notices = {name: sha((root / path).read_bytes()) for name, path in notice_paths.items()}
    report = json.dumps(verify(a.archive, a.target, ledger, provenance, notices, stage=stage), indent=2) + '\n'
    if a.report is not None:
        with a.report.open('x', encoding='utf-8') as f:
            f.write(report)
    print(report, end='')


if __name__ == '__main__':
    main()
