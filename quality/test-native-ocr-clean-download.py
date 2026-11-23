import hashlib, http.client, os, tempfile, time, urllib.error, urllib.request
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

import importlib.util
spec = importlib.util.spec_from_file_location('clean_conversion', Path(__file__).with_name('native-ocr-clean-conversion.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
acquire = module.acquire

class Response:
    def __init__(self, chunks, url='https://example.invalid/a'):
        self.chunks=iter(chunks);self.url=url
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def geturl(self):return self.url
    def read(self,n):
        v=next(self.chunks,b'')
        if isinstance(v,Exception):raise v
        return v
class Cases(TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.dest=self.root/'wheel';self.source='https://example.invalid/a'
        self.good=b'complete';self.expected={'bytes':len(self.good),'sha256':hashlib.sha256(self.good).hexdigest()}
        self.sleep=patch('time.sleep');self.sleep.start();self.addCleanup(self.sleep.stop)
    def run_fetch(self, responses):
        with patch('urllib.request.urlopen',side_effect=responses) as f:
            result=acquire(self.source,self.dest,self.expected)
            return result,f.call_count
    def test_timeout_after_partial_then_pass(self):
        self.assertEqual(self.run_fetch([Response([b'com',TimeoutError()]),Response([self.good])]),(self.expected,2))
        self.assertEqual(self.dest.read_bytes(),self.good);self.assertEqual(list(self.root.iterdir()),[self.dest])
    def test_five_transient_failures_leave_no_file(self):
        with patch('urllib.request.urlopen',side_effect=[TimeoutError()]*5) as f:
            with self.assertRaises(TimeoutError):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,5)
        self.assertEqual(list(self.root.iterdir()),[])
    def test_short_http_200_then_full_hash_verified(self):
        self.assertEqual(self.run_fetch([Response([self.good[:3]]), Response([self.good])]),
                         (self.expected, 2))
        self.assertEqual(self.dest.read_bytes(), self.good)
        self.assertEqual(list(self.root.iterdir()), [self.dest])

    def test_five_short_http_200_responses_fail_closed_without_files(self):
        with patch('urllib.request.urlopen', side_effect=[
            Response([self.good[:3]]) for _ in range(5)
        ]) as f:
            with self.assertRaisesRegex(module.IncompleteSourceError,
                                        r'SOURCE_INCOMPLETE: got=3 expected=8'):
                acquire(self.source, self.dest, self.expected)
            self.assertEqual(f.call_count, 5)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_http_502_then_good_integrity_pinned(self):
        error = urllib.error.HTTPError(self.source, 502, 'bad gateway', {}, None)
        self.assertEqual(self.run_fetch([error, error, Response([self.good])]),
                         (self.expected, 3))
        self.assertEqual(self.dest.read_bytes(), self.good)

    def test_short_then_same_size_wrong_digest_still_fails_immediately(self):
        # Retry only the short response. An exact-sized wrong model is not
        # admitted or retried as though it were a transient CDN failure.
        same_size_wrong = b'badmodel'
        self.assertEqual(len(same_size_wrong), self.expected['bytes'])
        with patch('urllib.request.urlopen', side_effect=[
            Response([self.good[:2]]), Response([same_size_wrong]),
            Response([self.good]),
        ]) as f:
            with self.assertRaisesRegex(RuntimeError, 'IDENTITY_MISMATCH'):
                acquire(self.source, self.dest, self.expected)
            self.assertEqual(f.call_count, 2)
        self.assertFalse(self.dest.exists())

    def test_bad_digest_not_retried(self):
        with patch('urllib.request.urlopen',return_value=Response([b'bad'])) as f:
            with self.assertRaisesRegex(RuntimeError,'IDENTITY_MISMATCH'):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,1)
        self.assertFalse(self.dest.exists())
    def test_oversize_not_retried(self):
        with patch('urllib.request.urlopen',return_value=Response([self.good+b'!'])) as f:
            with self.assertRaisesRegex(RuntimeError,'SOURCE_SIZE_EXCEEDED'):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,1)
        self.assertFalse(self.dest.exists())
    def test_insecure_redirect_not_retried(self):
        with patch('urllib.request.urlopen',return_value=Response([self.good],'http://example.invalid/a')) as f:
            with self.assertRaisesRegex(RuntimeError,'NON_HTTPS_SOURCE'):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,1)
    def test_existing_file_not_overwritten(self):
        self.dest.write_bytes(b'keep')
        with patch('urllib.request.urlopen') as f:
            with self.assertRaises(FileExistsError):acquire(self.source,self.dest,self.expected)
            f.assert_not_called()
        self.assertEqual(self.dest.read_bytes(),b'keep')
    def test_http_503_then_pass(self):
        err=urllib.error.HTTPError(self.source,503,'unavailable',{},None)
        self.assertEqual(self.run_fetch([err,Response([self.good])]),(self.expected,2))
    def test_404_not_retried(self):
        err=urllib.error.HTTPError(self.source,404,'missing',{},None)
        with patch('urllib.request.urlopen',side_effect=err) as f:
            with self.assertRaises(urllib.error.HTTPError):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,1)
    def test_certificate_error_not_retried(self):
        import ssl
        err=urllib.error.URLError(ssl.SSLCertVerificationError('invalid'))
        with patch('urllib.request.urlopen',side_effect=err) as f:
            with self.assertRaises(urllib.error.URLError):acquire(self.source,self.dest,self.expected)
            self.assertEqual(f.call_count,1)
    def test_promotion_race_does_not_clobber(self):
        def verify_and_create(path, expected):
            self.dest.write_bytes(b'external')
            return expected
        with patch.object(module, 'verify', side_effect=verify_and_create),patch('urllib.request.urlopen',return_value=Response([self.good])):
            with self.assertRaises(FileExistsError):acquire(self.source,self.dest,self.expected)
        self.assertEqual(self.dest.read_bytes(),b'external')
if __name__=='__main__':main(verbosity=2)
