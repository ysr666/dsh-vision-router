import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('native-ocr-delivery-preflight.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Cases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def fixture(self, target, mutate=None, extra=None):
        platform, arch = target.split('-')
        worker = 'worker.exe' if platform == 'win32' else 'worker'
        notices = dict(m.BASE_NOTICES)
        if platform == 'win32':
            notices.update(m.WIN_NOTICES)
        data = {worker: b'not executable', 'SOURCE-NOTICE.md': b'synthetic fixture'}
        models = {n: n.encode() for n in m.MODEL_NAMES}
        data.update({'models/' + n: b for n,b in models.items()})
        data.update({n: n.encode() for n in notices})
        facts = lambda b: {'bytes': len(b), 'sha256': m.sha(b)}
        provenance = {'nativeAssets': {n:facts(b) for n,b in models.items()}}
        sbom = {'bomFormat':'CycloneDX','specVersion':'1.6', 'metadata': {'component': {'hashes':[{'alg':'SHA-256','content':m.sha(data[worker])}]},'properties':[{'name':'dvr:distribution-ready','value':'false'}]},'compositions':[{'aggregate':'incomplete','assemblies':['worker']}]}
        data['SBOM.cdx.json'] = json.dumps(sbom).encode()
        schema = 4 if platform == 'win32' else 3
        manifest = {'schemaVersion':schema,'platform':platform,'arch':arch,'worker':facts(data[worker]),'models':provenance['nativeAssets'],'distributionReady':False,'files':{k:facts(v) for k,v in data.items()}}
        data['MANIFEST.json'] = json.dumps(manifest).encode()
        ledger = {'distributionReady':False, 'gates':{'ownerPublicationAuthorized':False},'platforms':{target:{'workerSha256':m.sha(data[worker]),'manifestSchema':schema,'memberCount':len(data)}}}
        expected_notices={n:m.sha(data[n]) for n in notices}
        if mutate:
            mutate(data,ledger,manifest,sbom)
        path = self.root / ('ppocrv6-small-'+target+'.tar.gz')
        with tarfile.open(path,'w:gz',format=tarfile.USTAR_FORMAT) as tf:
            for name,b in list(data.items())+([] if extra is None else [extra]):
                info=tarfile.TarInfo(m.PREFIX+name)
                info.size=len(b)
                tf.addfile(info,io.BytesIO(b))
        ledger['platforms'][target].update(archive=path.name,bytes=path.stat().st_size,sha256=m.sha(path.read_bytes()))
        return path,target,ledger,provenance,expected_notices

    def test_mac_valid(self):
        result=m.verify(*self.fixture('darwin-arm64'))
        self.assertEqual(result['members'],13)
        self.assertTrue(result['identityVerified']);self.assertFalse(result['distributionReady'])
    def test_windows_valid(self):
        self.assertEqual(m.verify(*self.fixture('win32-x64'))['members'],18)
    def test_outer_archive_tamper(self):
        args=self.fixture('win32-x64');path=args[0];b=path.read_bytes();path.write_bytes(b[:-1]+bytes([b[-1]^1]))
        with self.assertRaisesRegex(ValueError,'ARCHIVE_SHA_MISMATCH'):m.verify(*args)
    def test_duplicate(self):
        with self.assertRaisesRegex(ValueError,'DUPLICATE_MEMBER'):m.verify(*self.fixture('darwin-arm64',extra=('worker',b'bad')))
    def test_traversal(self):
        with self.assertRaisesRegex(ValueError,'UNEXPECTED_OR_DUPLICATE_MEMBER'):m.verify(*self.fixture('darwin-arm64',extra=('../danger',b'x')))
    def test_missing_member(self):
        with self.assertRaisesRegex(ValueError,'MISSING_MEMBER'):m.verify(*self.fixture('darwin-arm64',lambda d,*_:d.pop('models/rec.ncnn.bin')))
    def test_tampered_notice(self):
        with self.assertRaisesRegex(ValueError,'NOTICE_SHA_MISMATCH'):m.verify(*self.fixture('win32-x64',lambda d,*_:d.update({'MINGW-PTHREAD-SIGNAL-NOTICE.txt':b'altered'})))
    def test_model_tamper(self):
        with self.assertRaisesRegex(ValueError,'MODEL_SHA_OR_SIZE_MISMATCH'):m.verify(*self.fixture('darwin-arm64',lambda d,*_:d.update({'models/det.ncnn.bin':b'altered'})))
    def test_worker_tamper(self):
        with self.assertRaisesRegex(ValueError,'WORKER_SHA_MISMATCH'):m.verify(*self.fixture('win32-x64',lambda d,*_:d.update({'worker.exe':b'altered'})))
    def test_manifest_promotion(self):
        def mutate(d,l,man,sbom):
            man['distributionReady']=True;d['MANIFEST.json']=json.dumps(man).encode()
        with self.assertRaisesRegex(ValueError,'MANIFEST_IDENTITY_OR_GATE'):m.verify(*self.fixture('darwin-arm64',mutate))
    def test_sbom_promotion(self):
        def mutate(d,l,man,sbom):
            sbom['compositions'][0]['aggregate']='complete';d['SBOM.cdx.json']=json.dumps(sbom).encode();man['files']['SBOM.cdx.json']={'bytes':len(d['SBOM.cdx.json']),'sha256':m.sha(d['SBOM.cdx.json'])};d['MANIFEST.json']=json.dumps(man).encode()
        with self.assertRaisesRegex(ValueError,'SBOM_SCOPE'):m.verify(*self.fixture('darwin-arm64',mutate))
    def test_ledger_promotion(self):
        args=self.fixture('darwin-arm64');args[2]['gates']['ownerPublicationAuthorized']=True
        with self.assertRaisesRegex(ValueError,'UNEXPECTED_GATE_PROMOTION'):m.verify(*args)
    def test_duplicate_json_key(self):
        with self.assertRaisesRegex(ValueError,'DUPLICATE_JSON_KEY'):m.json_unique(b'{"x": 1, "x": 2}')

if __name__=='__main__':unittest.main(verbosity=2)
