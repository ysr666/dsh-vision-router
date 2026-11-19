import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('native-ocr-compiler-header-notices.py')
spec = importlib.util.spec_from_file_location('native_notice_audit', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class NoticeCases(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / 'toolchain'
        self.root.mkdir()

    def record(self, name: str, value: bytes) -> tuple[str, dict]:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
        return "toolchain/" + name, {'sha256': hashlib.sha256(value).hexdigest(), 'bytes': len(value), 'riskHints': []}

    def test_captures_license_comment_without_copying_code(self):
        key, fact = self.record('generic-w64-mingw32/include/fixture.h',
            b'/* Copyright A. N. Other; permission is hereby granted. */\n'
            b'static inline int foo(void){return 42;}\n')
        obj = mod.one_header(key, fact, self.root)
        self.assertEqual(obj['noticeCommentCount'], 1)
        self.assertIn('permission is hereby granted', obj['noticeCommentsCaptured'][0]['excerpt'])
        self.assertNotIn('return 42', obj['noticeCommentsCaptured'][0]['excerpt'])
        self.assertTrue(obj['possibleHeaderInlineDefinitions'])
        self.assertEqual(obj['humanLicenseReview'], 'required')

    def test_spdx_is_recorded_but_not_clearance(self):
        key, fact = self.record('lib/clang/23/include/vector.h',
            b'// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\nint x;\n')
        obj = mod.one_header(key, fact, self.root)
        self.assertEqual(obj['spdxTextObserved'], ['Apache-2.0 WITH LLVM-exception'])
        self.assertEqual(obj['humanLicenseReview'], 'required')

    def test_rejects_changed_header_bytes(self):
        key, fact = self.record('lib/clang/23/include/a.h', b'/* LICENSE */\n')
        (self.root / key.removeprefix("toolchain/")).write_bytes(b'/* LICENSE and changed */\n')
        with self.assertRaisesRegex(ValueError, 'HEADER_BYTES_CHANGED'):
            mod.one_header(key, fact, self.root)

    def test_rejects_symlink_escape_and_traversal(self):
        key, fact = self.record('lib/clang/23/include/a.h', b'// Copyright 2026\n')
        target = self.root.parent / 'elsewhere.h'
        target.write_bytes((self.root / key.removeprefix("toolchain/")).read_bytes())
        (self.root / key.removeprefix("toolchain/")).unlink()
        (self.root / key.removeprefix("toolchain/")).symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_HEADER_PATH'):
            mod.one_header(key, fact, self.root)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_HEADER_KEY'):
            mod.one_header('../elsewhere.h', fact, self.root)

    def test_rejects_incorrect_provenance_and_missing_closure(self):
        with self.assertRaisesRegex(ValueError, 'INCORRECT_CRT_EVIDENCE'):
            mod.inventory({'sourceRevision': 'untrusted'}, self.root)
        x = {
            'sourceRevision': mod.SOURCE_REVISION,
            'compilerArchiveSha256': mod.TOOL_ARCHIVE_SHA256,
            'normalizedMatches': 68, 'exactStrippedObjectReplayMatches': 68,
            'distributionReady': False, 'dependencies': {}, 'perObject': {},
        }
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_CRT_DEPENDENCIES'):
            mod.inventory(x, self.root)


if __name__ == '__main__':
    unittest.main()
