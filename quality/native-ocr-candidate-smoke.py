"""Check an isolated native worker using an independently rendered BMP.
No DSH profile, network, model upload, or persistent install is involved.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import re

def frame(w, h, data):
    return b'DVR3OCR1' + struct.pack('<III', w, h, len(data)) + data

def rgb_bmp(file):
    raw = file.read_bytes()
    assert raw[:2] == b'BM'
    offset, dib, w, h, planes, bits, compression = struct.unpack_from('<IIiiHHI', raw, 10)
    assert dib >= 40 and 0 < w <= 2048 and 0 < abs(h) <= 2048
    assert planes == 1 and bits in (24, 32) and compression == 0
    stride = ((w * bits + 31) // 32) * 4
    assert offset + stride * abs(h) <= len(raw)
    data = bytearray()
    rows = range(abs(h)-1, -1, -1) if h > 0 else range(-h)
    for row in rows:
        for col in range(w):
            start = offset + row * stride + col * (bits // 8)
            b, g, r = raw[start:start+3]
            data.extend((r,g,b))
    return w, abs(h), bytes(data)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--bmp', type=Path, required=True)
    parser.add_argument('--expected', default='HELLO 123')
    parser.add_argument('--model-origin', choices=['windows-canonical','mac-audit-only'], default='windows-canonical')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    worker, models = args.worker.resolve(), args.models.resolve()
    root = Path(__file__).resolve().parent
    ledger = json.loads((root / 'native-ocr-provenance-LAB.json').read_text())
    expected_assets = dict(ledger['nativeAssets'])
    if args.model_origin == 'mac-audit-only':
        candidate = json.loads((root / 'native-ocr-candidate-models.json').read_text())
        expected_assets.update(candidate['macParameterOverrides'])
    for name, entry in expected_assets.items():
        f = models / name
        assert f.stat().st_size == entry['bytes']
        assert hashlib.sha256(f.read_bytes()).hexdigest() == entry['sha256']
    def invoke(payload):
        return subprocess.run([str(worker), str(models)], input=payload,
                              capture_output=True, timeout=30, check=False)
    def successful(payload):
        result = invoke(payload)
        if result.returncode: raise RuntimeError(f'WORKER_EXIT={result.returncode}')
        data = json.loads(result.stdout)
        assert isinstance(data['text'], str)
        assert isinstance(data['confidence'], (int,float)) and 0 <= data['confidence'] <= 1
        return data
    w,h,rgb = rgb_bmp(args.bmp)
    result = successful(frame(w,h,rgb))
    if re.sub(r'\s+', '', result['text']) != re.sub(r'\s+', '', args.expected):
        raise RuntimeError(f'UNEXPECTED_TEXT={result["text"]!r}')
    blank = successful(frame(320, 128, b'\xff' * (320*128*3)))
    assert not blank['text'].strip(), 'blank image returned text'
    bad = invoke(b'BAD')
    assert bad.returncode != 0, 'malformed payload was accepted'
    again = successful(frame(w,h,rgb))
    assert again['text'] == result['text'], 'recognition did not recover'
    report = {'workerSha256': hashlib.sha256(worker.read_bytes()).hexdigest(),
              'expected': args.expected, 'actual': result['text'],
              'confidence': result['confidence'], 'blankPass': True,
              'malformedPass': True, 'recoveryPass': True,
              'modelOrigin': args.model_origin, 'distributionReady': False}
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print('NATIVE_CANDIDATE_SMOKE_PASS ' + json.dumps(report, ensure_ascii=True))

if __name__ == '__main__':
    main()
