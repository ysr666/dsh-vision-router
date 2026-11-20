"""Reconstruct Windows-canonical ncnn text serialization from equivalent Mac output.
The handoff is labels, whitespace and Split alias indices only. No weights,
raw parameter files, operator attributes or input producer indices are carried.
Every real input and final output is checked against existing exact SHA pins.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

LIMIT = 256 * 1024
NAMES = ('det.ncnn.param', 'rec.ncnn.param')
REPO = Path(__file__).resolve().parent.parent

def sha(value):
    return hashlib.sha256(value).hexdigest()

def require(ok, detail):
    if not ok:
        raise ValueError(detail)

def split(line):
    matches = list(re.finditer(r'\S+', line))
    spaces = []
    end = 0
    for m in matches:
        spaces.append(line[end:m.start()])
        end = m.end()
    spaces.append(line[end:])
    return [m.group() for m in matches], spaces

def parse(raw):
    require(0 < len(raw) <= LIMIT and raw.isascii(), 'PARAM_SIZE_OR_ENCODING')
    lines = raw.decode('ascii').splitlines(keepends=True)
    require(len(lines) >= 3, 'SHORT_GRAPH')
    magic, ms = split(lines[0])
    header, hs = split(lines[1])
    require(magic == ['7767517'] and len(header) == 2, 'GRAPH_HEADER')
    n, m = map(int, header)
    require(0 < n <= 4096 and 0 < m <= 16384 and len(lines) == n+2, 'GRAPH_COUNT')
    blobs, rows, graph = {}, [], []
    for i, line in enumerate(lines[2:]):
        tokens, spacing = split(line)
        require(len(tokens) >= 4, 'GRAPH_ROW')
        kind, name, ni, no = tokens[:4]
        ni, no = int(ni), int(no)
        require(0 <= ni <= 256 and 0 < no <= 256 and len(tokens) >= 4+ni+no, 'GRAPH_ARITY')
        inputs = tokens[4:4+ni]
        outputs = tokens[4+ni:4+ni+no]
        params = tokens[4+ni+no:]
        require(all(k in blobs for k in inputs), 'GRAPH_EDGE')
        if kind == 'Split':
            require(ni == 1 and not params, 'SPLIT_SHAPE')
        edges = [blobs[k] for k in inputs]
        normalized = [[p, 0 if rows[p]['kind']=='Split' else slot] for p, slot in edges]
        graph.append([kind, normalized, no, params])
        for slot, key in enumerate(outputs):
            require(key not in blobs, 'DUPLICATE_BLOB')
            blobs[key] = (i,slot)
        rows.append(dict(kind=kind,name=name,ni=ni,no=no,arity=tokens[2:4],
                         edges=edges,outputs=outputs,params=params,spacing=spacing))
    require(len(blobs)==m and {'in0','out0'}<=blobs.keys(), 'GRAPH_ENDPOINT')
    endpoints = {key:[p,0 if rows[p]['kind']=='Split' else slot]
                 for key,(p,slot) in blobs.items() if key in ('in0','out0')}
    endpoints = {key:endpoints[key] for key in ('in0','out0')}
    fingerprint = sha(json.dumps([graph,endpoints],separators=(',',':')).encode())
    return dict(magic=magic,header=header,headerSpacing=[ms,hs],rows=rows,fingerprint=fingerprint)

def identity(raw, expected):
    require(len(raw)==expected['bytes'] and sha(raw)==expected['sha256'], 'PARAM_IDENTITY')

def make_labels(raw, expected, fingerprint):
    identity(raw, expected)
    g = parse(raw)
    require(g['fingerprint']==fingerprint,'CANONICAL_GRAPH_MISMATCH')
    labels = []
    for row in g['rows']:
        labels.append({
            'name':row['name'],'outputs':row['outputs'],
            'splitAliases':[slot if g['rows'][p]['kind']=='Split' else None for p,slot in row['edges']],
            'spacing':row['spacing'],
        })
    return dict(schemaVersion=1,canonicalSha256=expected['sha256'],graphFingerprint=fingerprint,
                headerSpacing=g['headerSpacing'],labels=labels)

def render(tokens, spaces):
    require(isinstance(spaces,list) and len(spaces)==len(tokens)+1,'SPACING_COUNT')
    require(all(isinstance(s,str) and len(s)<=512 and re.fullmatch(r'[ \t]*',s)
                for s in spaces[:-1]),'SPACING_FORMAT')
    require(isinstance(spaces[-1],str) and len(spaces[-1])<=512 and
            re.fullmatch(r'[ \t]*(?:\r?\n)?',spaces[-1]),'END_SPACING_FORMAT')
    require(all(spaces[i] for i in range(1,len(tokens))),'MISSING_TOKEN_SEPARATOR')
    return ''.join(s+t for s,t in zip(spaces,tokens))+spaces[-1]

def label(value):
    require(isinstance(value,str) and 0 < len(value)<=256 and
            re.fullmatch(r'[\x21-\x7e]+',value),'LABEL_FORMAT')
    return value

def rebuild(raw, recipe, source_expected, target_expected, fingerprint):
    identity(raw, source_expected)
    g = parse(raw)
    require(set(recipe)=={'schemaVersion','canonicalSha256','graphFingerprint','headerSpacing','labels'}
            and recipe['schemaVersion']==1 and recipe['canonicalSha256']==target_expected['sha256']
            and recipe['graphFingerprint']==g['fingerprint']==fingerprint,'RECIPE_IDENTITY')
    rows = g['rows']
    labels = recipe['labels']
    require(isinstance(labels,list) and len(labels)==len(rows),'LABEL_ROW_COUNT')
    output = [render(g['magic'],recipe['headerSpacing'][0]),render(g['header'],recipe['headerSpacing'][1])]
    names = []
    for i,(row,entry) in enumerate(zip(rows,labels)):
        require(set(entry)=={'name','outputs','splitAliases','spacing'},'UNEXPECTED_RECIPE_FIELDS')
        require(len(entry['outputs'])==row['no'] and len(entry['splitAliases'])==row['ni'],'LABEL_ARITY')
        outputs = [label(x) for x in entry['outputs']]
        inputs = []
        for (producer,slot),alias in zip(row['edges'],entry['splitAliases']):
            if rows[producer]['kind']=='Split':
                require(type(alias) is int and 0<=alias<len(names[producer]),'SPLIT_ALIAS')
                slot=alias
            else:
                require(alias is None,'NON_SPLIT_ALIAS')
            inputs.append(names[producer][slot])
        names.append(outputs)
        output.append(render([row['kind'],label(entry['name']),*row['arity'],
                              *inputs,*outputs,*row['params']],entry['spacing']))
    result=''.join(output).encode('ascii')
    identity(result,target_expected)
    require(parse(result)['fingerprint']==fingerprint,'REBUILT_GRAPH_MISMATCH')
    return result

def source_ledgers():
    original=json.loads((REPO/'quality/native-ocr-provenance-LAB.json').read_text())
    candidate=json.loads((REPO/'quality/native-ocr-candidate-models.json').read_text())
    return original['nativeAssets'],candidate['macParameterOverrides'],candidate['graphFingerprints']

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode',choices=['emit','rebuild'],required=True)
    p.add_argument('--models',required=True,type=Path)
    p.add_argument('--recipe',required=True,type=Path)
    p.add_argument('--out',type=Path)
    a=p.parse_args()
    targets,sources,fingerprints=source_ledgers()
    if a.mode=='emit':
        require(a.out is None,'UNEXPECTED_OUT')
        value={name:make_labels((a.models/name).read_bytes(),targets[name],fingerprints[name]) for name in NAMES}
        payload=(json.dumps(value,indent=2)+'\n').encode()
        require(len(payload)<1024*1024,'LABEL_RECIPE_SIZE')
        with a.recipe.open('xb') as f:f.write(payload)
        print('CANONICAL_LABEL_RECIPE',sha(payload),'no raw parameter files, weights or worker content')
        return
    require(a.out is not None and not a.out.exists(),'FRESH_OUTPUT_REQUIRED')
    require(0<a.recipe.stat().st_size<1024*1024,'LABEL_RECIPE_SIZE')
    recipe=json.loads(a.recipe.read_bytes())
    require(set(recipe)==set(NAMES),'LABEL_RECIPE_SET')
    verified={}
    for name,expected in targets.items():
        raw=(a.models/name).read_bytes()
        if name in NAMES:
            raw=rebuild(raw,recipe[name],sources[name],expected,fingerprints[name])
        identity(raw,expected)
        verified[name]=raw
    a.out.mkdir()
    try:
        for name,raw in verified.items():
            with (a.out/name).open('xb') as f:f.write(raw)
    except Exception:
        shutil.rmtree(a.out)
        raise
    print('MAC_TO_WINDOWS_CANONICAL_ASSETS 5/5 exact SHA-256; no publication')

if __name__=='__main__':
    main()
