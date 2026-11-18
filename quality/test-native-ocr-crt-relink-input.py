import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('relink', Path(__file__).with_name('native-ocr-crt-relink-LAB.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Cases(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.archive = self.root/'input.zip'
        self.manifest = b'[]\n'
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr('manifest.json', self.manifest)
        self.archive_sha = m.sha(self.archive)
        self.manifest_sha = hashlib.sha256(self.manifest).hexdigest()

    def test_original_mode_still_pins_private_zip(self):
        with patch.object(m, 'REPLACEMENT_SHA256', self.archive_sha):
            self.assertEqual(m.replacement_identity(self.archive, False), self.archive_sha)
            with self.assertRaisesRegex(RuntimeError, 'archive identity mismatch'):
                m.replacement_identity(self.archive, True)

    def test_reconstructed_mode_pins_both_zip_and_manifest(self):
        with patch.object(m, 'SOURCE_RECONSTRUCTED_SHA256', self.archive_sha), patch.object(m, 'SOURCE_RECONSTRUCTED_MANIFEST_SHA256', self.manifest_sha):
            self.assertEqual(m.replacement_identity(self.archive, True), self.archive_sha)
            with self.assertRaisesRegex(RuntimeError, 'archive identity mismatch'):
                m.replacement_identity(self.archive, False)

    def test_reconstructed_mode_refuses_wrong_manifest(self):
        with patch.object(m, 'SOURCE_RECONSTRUCTED_SHA256', self.archive_sha):
            with self.assertRaisesRegex(RuntimeError, 'manifest identity mismatch'):
                m.replacement_identity(self.archive, True)

    def test_unreviewed_zip_refused(self):
        for mode in (False, True):
            with self.assertRaisesRegex(RuntimeError, 'archive identity mismatch'):
                m.replacement_identity(self.archive, mode)


if __name__ == '__main__':
    unittest.main(verbosity=2)
