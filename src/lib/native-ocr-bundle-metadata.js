import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXPERIMENTAL_OCR_MODEL_FILES } from './native-ocr-integrity.js'

const detector = 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/tree/28fe5895c24fd108c19eb3e8479f4ab385fbfc62'
const recognizer = 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/tree/b8f84f0b80c529de40b4fbb3544b84fa7233a513'
const dictionary = 'https://github.com/PaddlePaddle/PaddleOCR/tree/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf'
const runtime = 'https://github.com/Tencent/ncnn/tree/d1f6ac67e9fc91390cc70f7168573fd2626f1d66'
export const NATIVE_BUNDLE_METADATA_FILES = Object.freeze(['SOURCE-NOTICE.md', 'SBOM.cdx.json', 'PROJECT-LICENSE.txt'])
export function nativeBundleLicenseFiles(platform = process.platform) {
  return [
    ['assets/licenses/ncnn-LICENSE.txt', 'NCNN-LICENSE.txt'],
    ['assets/licenses/apache-2.0.txt', 'APACHE-2.0.txt'],
    ...(platform === 'win32' ? [
      ['assets/licenses/llvm-mingw-LICENSE.txt', 'LLVM-LICENSE.txt'],
      ['assets/licenses/mingw-w64-runtime-COPYING.txt', 'MINGW-RUNTIME-COPYING.txt'],
    ] : []),
    ['LICENSE', 'PROJECT-LICENSE.txt'],
  ]
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = sha256 => [{ alg: 'SHA-256', content: sha256 }]
const license = id => [{ license: { id } }]
const component = (ref, name, version, source, id, extra = {}) => ({
  type: 'library', 'bom-ref': ref, name, version,
  licenses: license(id), externalReferences: [{ type: 'vcs', url: source }], ...extra,
})
export async function nativeBundleMetadata({ root, platform = process.platform, arch = process.arch }) {
  const win = platform === 'win32'
  const workerName = win ? 'worker.exe' : 'worker'
  const worker = await readFile(join(root, workerName))
  const workerSha = digest(worker)
  const modelFiles = Object.entries(EXPERIMENTAL_OCR_MODEL_FILES)
  const components = [
    component('ncnn', 'ncnn', 'd1f6ac67e9fc91390cc70f7168573fd2626f1d66', runtime, 'BSD-3-Clause', {
      description: 'CPU-only static runtime; additional zlib and BSD notices in NCNN-LICENSE.txt.',
    }),
    ...modelFiles.map(([name, entry]) => ({
      ...component('model:' + name, name,
        name.startsWith('det.') ? '28fe5895c24fd108c19eb3e8479f4ab385fbfc62'
          : name.startsWith('rec.') ? 'b8f84f0b80c529de40b4fbb3544b84fa7233a513'
            : 'dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf',
        name.startsWith('det.') ? detector : name.startsWith('rec.') ? recognizer : dictionary, 'Apache-2.0'),
      type: 'file', hashes: hash(entry.sha256),
    })),
    ...(win ? [component('llvm', 'LLVM embedded runtime / compiler-rt, libc++, unwind', 'LLVM-MinGW 20261020',
      'https://github.com/mstorsjo/llvm-mingw/releases/tag/20261020', 'Apache-2.0', {
        licenses: [{ expression: 'Apache-2.0 WITH LLVM-exception' }],
      }), {
        type:'library', 'bom-ref':'mingw', name:'MinGW-w64 runtime/header objects',
        version:'LLVM-MinGW 20261020',
        description:'Mixed notices: see MINGW-RUNTIME-COPYING.txt. Exact candidate link/header review must precede redistribution.',
        externalReferences:[{type:'vcs',url:'https://github.com/mstorsjo/llvm-mingw/releases/tag/20261020'}],
      }] : []),
  ]
  const payload = Object.fromEntries(await Promise.all([
    workerName, ...modelFiles.map(([name]) => 'models/' + name),
    ...nativeBundleLicenseFiles(platform).map(([, name]) => name),
  ].map(async name => {
    const bytes = await readFile(join(root, name))
    return [name, { bytes: bytes.length, sha256: digest(bytes) }]
  })))
  const notice = [
    '# Locally installed native OCR assets', '',
    'Native wrapper: dsh-vision-router contributors (MIT; PROJECT-LICENSE.txt).',
    'Detector: PaddlePaddle/PP-OCRv6_small_det_onnx, Apache-2.0.',
    'Source: ' + detector,
    'Recognizer: PaddlePaddle/PP-OCRv6_small_rec_onnx, Apache-2.0.',
    'Source: ' + recognizer,
    'Dictionary: PaddlePaddle/PaddleOCR ppocrv6_dict.txt, Apache-2.0.',
    'Source: ' + dictionary,
    'Modification: detector and recognizer ONNX models converted to ncnn param/bin with pnnx 20261020, fp16=0, optlevel=2; dictionary unchanged.',
    'Runtime: Tencent/ncnn @ d1f6ac67e9fc91390cc70f7168573fd2626f1d66, BSD-3-Clause',
    'Source: ' + runtime,
    'Additional BSD-2-Clause and zlib notices are in NCNN-LICENSE.txt.',
    win ? 'Windows: embedded LLVM runtime with Apache-2.0 WITH LLVM exceptions and MinGW-w64 runtime notices; OS UCRT and KERNEL32 are not bundled.'
      : 'macOS: system libc++ and libSystem are not bundled.',
    'Build-only converter: pnnx 20261020; converter executable is not included.',
    'Worker SHA-256: ' + workerSha,
    'This owner-installed inventory does not constitute public redistribution approval. See SBOM.cdx.json and applicable license texts.', '',
  ].join('\n')
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { component: { type:'application', 'bom-ref':'worker', name:'dsh-vision-router native OCR worker',
      version:workerSha, hashes: hash(workerSha), licenses:license('MIT'),
      description:'MIT-licensed project wrapper; the listed statically incorporated third-party components retain their own licenses.' },
      properties: [{name:'dvr:target',value:platform+'-'+arch},
        {name:'dvr:distribution-ready',value:'false'},
        {name:'dvr:scope',value:'Owner-installed payload inventory; build-only tools and OS-provided libraries excluded; final exact link/header review outstanding'}] },
    components,
    dependencies: [{ref:'worker', dependsOn:components.map(c=>c['bom-ref'])}],
    compositions: [{aggregate:'incomplete', assemblies:['worker']}],
  }
  const stringify = value => JSON.stringify(value,null,2)+'\n'
  const files = { 'SOURCE-NOTICE.md':notice, 'SBOM.cdx.json':stringify(sbom) }
  const manifest = { schemaVersion:2, platform, arch, worker:{sha256:workerSha,bytes:worker.length},
    models:EXPERIMENTAL_OCR_MODEL_FILES, modelLicense:'Apache-2.0',
    ncnnSource:'Tencent/ncnn@d1f6ac67e9fc91390cc70f7168573fd2626f1d66',
    distributionReady:false,
    files:{ ...payload, ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, {
      bytes:Buffer.byteLength(value), sha256:digest(value)
    }]))},
  }
  return {...files,'MANIFEST.json':stringify(manifest)}
}
