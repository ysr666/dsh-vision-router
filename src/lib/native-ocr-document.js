import { performance } from 'node:perf_hooks'
import { encodeNativeOcrRgbFrame } from './native-ocr-supervisor.js'
import { recoverPhotoQuestionHeadings } from './native-ocr-question-labels.js'
import { reviewChemicalStateGlyphs } from './native-ocr-chemistry-review.js'
import { detectRedAnnotationNearText } from './native-ocr-annotation-risk.js'

const MAX_DOCUMENT_TILES = 8
const MAX_DOCUMENT_TIME_MS = 24_000

function clamp(value,min,max) { return Math.max(min,Math.min(max,value)) }

function detectPortraitGutter(rgb,width,height) {
  if (height < 900 || height / width < 1.28) return null
  const from=Math.max(13,Math.round(width*.05))
  const until=Math.min(width-12,Math.round(width*.28))
  const y0=Math.round(height*.20),y1=Math.round(height*.83)
  const scores=[]
  let meanBrightness=0,n=0
  const gray=(pixel)=>.299*rgb[pixel]+.587*rgb[pixel+1]+.114*rgb[pixel+2]
  for (let x=from;x<until;x+=2) {
    let diff=0,count=0
    for (let y=y0;y<y1;y+=6) {
      let left=0,right=0
      const offset=(y*width+x)*3
      for(let d=1;d<=10;d++)left+=gray(offset-3*d)
      for(let d=0;d<10;d++)right+=gray(offset+3*d)
      diff+=Math.abs(right-left)/10
      count++
      if(x===from){meanBrightness+=gray(offset);n++}
    }
    scores.push({x,score:diff/Math.max(1,count)})
  }
  if (!scores.length || meanBrightness/Math.max(1,n)<120) return null
  const sorted=[...scores].sort((a,b)=>a.score-b.score)
  const med=sorted[Math.floor(sorted.length/2)].score
  const best=sorted.at(-1)
  if (best.score < med*1.27 || best.x < from+4 || best.x >= until-4) return null
  // Leave a small safety margin to preserve question numbers and decimals
  // beside the spine; a ten-pixel inward shift proved able to drop a line.
  return clamp(best.x-5,0,Math.floor(width*.25))
}

function cropRGB(rgb,width,rect) {
  const {x,y,w,h}=rect
  const dst=Buffer.allocUnsafe(w*h*3)
  for(let row=0;row<h;row++) {
    const from=((row+y)*width+x)*3
    const to=row*w*3
    dst.set(rgb.subarray(from,from+w*3),to)
  }
  return dst
}
function intersection(boxA,boxB) {
  return Math.max(0,Math.min(boxA[2],boxB[2])-Math.max(boxA[0],boxB[0])) *
    Math.max(0,Math.min(boxA[3],boxB[3])-Math.max(boxA[1],boxB[1]))
}
function area(b) { return Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]) }
function centerY(b) {return (b[1]+b[3])/2}
function isQuestionNumber(value) {
  return /^(?:[1-9]|1[012])[.]?$/.test(value.trim())
}
function markRisk(value) {
  return /[A-Za-z][0-9]|[0-9][A-Za-z]|[₀-₉⁰-⁹]|[=→×Δ]/u.test(value)
}
function mergeTileRegions(items) {
  const merged=[]
  for(const r of items.sort((a,b)=>centerY(a.box)-centerY(b.box))) {
    if(!Array.isArray(r.box) || r.box.length!==4 ||
       !r.box.every(Number.isFinite) || !r.text?.trim() ||
       !Number.isFinite(r.confidence))continue
    let match=-1
    for(let i=0;i<merged.length;i++) {
      const prev=merged[i]
      const overlap=intersection(r.box,prev.box)
      const iou=overlap/Math.max(1,area(r.box)+area(prev.box)-overlap)
      const overlapWide=Math.max(0,Math.min(r.box[2],prev.box[2])-Math.max(r.box[0],prev.box[0])) /
        Math.max(1,Math.max(r.box[2]-r.box[0],prev.box[2]-prev.box[0]))
      const sameBaseline=Math.abs(centerY(r.box)-centerY(prev.box)) <
        Math.max(12,.55*Math.max(r.box[3]-r.box[1],prev.box[3]-prev.box[1]))
      if (sameBaseline && (iou>.48 || (overlapWide>.75 && overlap/Math.max(1,Math.min(area(r.box),area(prev.box)))>.7))) {
        match=i
        break
      }
    }
    if(match===-1){merged.push(r);continue}
    const old=merged[match]
    const favorable=(r.edgeClearance>12?1:0)-(old.edgeClearance>12?1:0)
    const selected=favorable>0 || (favorable===0 && (r.confidence>old.confidence ||
      (r.confidence===old.confidence && r.text.length>old.text.length)))
    if(selected)merged[match]={...r,uncertain:r.uncertain ||
      (markRisk(old.text+r.text) && r.text!==old.text)}
    else if(r.text!==old.text && markRisk(old.text+r.text))old.uncertain=true
  }
  // Numbers and the text of their question often form two coincident boxes.
  const kept=merged.filter((r)=>!isQuestionNumber(r.text) ||
    !merged.some((other)=>other!==r &&
      Math.abs(centerY(other.box)-centerY(r.box))<15 &&
      other.text.trim().startsWith(r.text.trim()) &&
      other.text.trim().length>r.text.trim().length+8))
  // The old 'abs(y1-y2)<12 ? x : y' comparator was non-transitive.
  // Quantized reading rows establish a stable total order even with
  // overlapping annotations or adjacent text boxes.
  kept.sort((a,b)=> {
    const cy=centerY(a.box),dy=centerY(b.box)
    const rowA=Math.round(cy/16),rowB=Math.round(dy/16)
    return rowA-rowB || a.box[0]-b.box[0] || cy-dy
  })
  return kept
}

export function planExperimentalDocumentTiles(rgb,width,height,coarse) {
  const regions=Array.isArray(coarse?.regions) ? coarse.regions : []
  if (height/width<1.28 || height<900 || regions.length<9) return []
  const x=detectPortraitGutter(rgb,width,height) ?? 0
  const w=width-x
  const valid=regions.filter(r=>Array.isArray(r.box) &&
    r.box.length===4 && r.box.every(Number.isFinite) &&
    r.box[3]>r.box[1] && r.box[3]-r.box[1]<height*.12)
  if (valid.length<8) return []
  const upper=clamp(Math.floor(Math.min(...valid.map(r=>r.box[1]))-18),0,height-80)
  const lower=clamp(Math.ceil(Math.max(...valid.map(r=>r.box[3]))+30),upper+80,height)
  const tileHeight=clamp(Math.round(w*.34),260,840)
  const overlap=clamp(Math.round(tileHeight*.16),30,85)
  const step=tileHeight-overlap
  if (Math.ceil((lower-upper)/step)>MAX_DOCUMENT_TILES) return []
  const tiles=[]
  for(let y=upper;y<lower;y+=step) {
    const h=Math.min(tileHeight,lower-y)
    if(h<50) break
    tiles.push({x,y,w,h})
    if(y+h>=lower)break
  }
  return tiles.length>=2 ? tiles : []
}

/** Experimental document mode. Never replaces the user-selected OCR engine. */
export async function runExperimentalNativeDocumentOcr(rgb,width,height,{
  nativeRun,timeoutMs=16_000,signal
}={}) {
  if(!(rgb instanceof Uint8Array))throw new TypeError('OCR RGB pixels required')
  if(typeof nativeRun!=='function')throw new TypeError('nativeRun is required')
  if(!Number.isFinite(timeoutMs) || timeoutMs<=0)
    throw Object.assign(new Error('Invalid OCR deadline'),{code:'OCR_INVALID_TIMEOUT'})
  if(signal?.aborted)
    throw Object.assign(new Error('OCR cancelled'),{code:'OCR_CANCELLED'})
  const full=encodeNativeOcrRgbFrame(rgb,width,height)
  const started=performance.now()
  const budget=clamp(timeoutMs,1,MAX_DOCUMENT_TIME_MS)
  const remaining=()=>Math.max(0,budget-(performance.now()-started))
  const initial=await nativeRun(full,{timeoutMs:Math.max(1,remaining()),signal})
  if(signal?.aborted)
    throw Object.assign(new Error('OCR cancelled'),{code:'OCR_CANCELLED'})
  if(!initial || typeof initial.text!=='string')
    throw Object.assign(new Error('Invalid OCR worker result'),{code:'OCR_INVALID_RESULT'})
  const tiles=planExperimentalDocumentTiles(rgb,width,height,initial)
  if(!tiles.length)return {...initial,tilesUsed:0}
  const items=[]
  let partial=false
  for(const tile of tiles) {
    if(signal?.aborted)throw Object.assign(new Error('OCR cancelled'),{code:'OCR_CANCELLED'})
    if(remaining()<750){partial=true;break}
    const frame=encodeNativeOcrRgbFrame(cropRGB(rgb,width,tile),tile.w,tile.h)
    let out
    try {out=await nativeRun(frame,{timeoutMs:Math.max(1,remaining()),signal})}
    catch(error) {
      if(error?.code==='OCR_CANCELLED' || signal?.aborted)throw error
      partial=true
      break
    }
    if(!Array.isArray(out.regions)){partial=true;break}
    for(const r of out.regions) {
      const [x1,y1,x2,y2]=r.box??[]
      if (![x1,y1,x2,y2].every(Number.isFinite))continue
      items.push({...r,
        box:[tile.x+x1,tile.y+y1,tile.x+x2,tile.y+y2],
        edgeClearance:Math.min(y1,tile.h-y2),
      })
    }
  }
  if(partial || !items.length)return {...initial,uncertain:true,review:'document_refinement_incomplete',tilesUsed:0}
  const regions=mergeTileRegions(items)
  // In a photographed textbook the printed question numbers can sit left of
  // the detected main text column. Recover them from one bounded left strip.
  // Never replace the full sentence with a truncated strip reading.
  // A narrow gutter probe supplements the detected whole-line text. It cannot
  // assign a question number by itself: the pure matching module requires
  // Chinese content alignment plus monotonic question-number evidence.
  const marginLabels=[]
  if (regions.length>=9 && remaining()>1000) {
    const first=tiles[0]
    const last=tiles.at(-1)
    const sx=clamp(first.x-40,0,width-1)
    const sy=clamp(Math.round(first.y+(last.y+last.h-first.y)*.40),0,height-1)
    const strip={x:sx,y:sy,w:Math.min(210,width-sx),h:last.y+last.h-sy}
    if(strip.w>=75 && strip.h>=110 && strip.w*strip.h<=4_000_000) {
      try {
        const frame=encodeNativeOcrRgbFrame(cropRGB(rgb,width,strip),strip.w,strip.h)
        const left=await nativeRun(frame,{timeoutMs:Math.max(1,remaining()),signal})
        if(Array.isArray(left?.regions)) {
          for(const candidate of left.regions) {
            if(!Array.isArray(candidate.box) || candidate.box.length!==4)continue
            const [x1,y1,x2,y2]=candidate.box
            if(![x1,y1,x2,y2].every(Number.isFinite))continue
            marginLabels.push({
              text: candidate.text,
              confidence: candidate.confidence,
              box:[sx+x1,sy+y1,sx+x2,sy+y2]
            })
          }
        }
      } catch(error) {
        if(signal?.aborted || error?.code==='OCR_CANCELLED')throw error
      }
    }
  }
  const recovery=recoverPhotoQuestionHeadings(regions,marginLabels)
  const phaseReview=reviewChemicalStateGlyphs(regions)
  const labelsRecovered=recovery.recovered.length
  // Keep original evidence and localize high-impact uncertainty. An OCR
  // confidence score cannot establish that a decimal point is present.
  const reviewQueue=regions.filter(r=>r.uncertain &&
    /\d/.test(r.text) && /(?:g|kg|kJ|mol|℃|°C|[A-Z]\d)/u.test(r.text))
    .map(r=>{
      const red=detectRedAnnotationNearText(rgb,width,height,r.box)
      const reason=r.formulaDigitReconciled ? 'formula_digit_conflict_between_views' :
        r.phaseGlyphReconciled ? 'chemical_state_glyph_conflict' :
        red.detected ? 'numeric_text_overlapped_by_red_annotation' : 'verify_numeric_or_formula'
      return {
        box:r.box,text:r.text,reason,
        redInkEvidence:red.detected ? red : undefined,
        evidence:r.formulaRecoveryEvidence??r.phaseEvidence??null,
      }
    })
  const text=regions.map(r=>r.text).join('\n')
  const confidence=regions.length ?
    regions.reduce((v,r)=>v+r.confidence,0)/regions.length : 0
  return {text,confidence,regions,uncertain:regions.some(x=>x.uncertain),
    engine:'ncnn',tilesUsed:tiles.length,labelsRecovered,
    formulaDigitsReconciled:recovery.formulaReconciled.length,
    phaseGlyphReconciled:phaseReview.updates.length,
    reviewQueue,
    rejectedQuestionLabelCandidates:recovery.rejected.length,documentRefined:true}
}
