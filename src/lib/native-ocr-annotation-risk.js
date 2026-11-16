/**
 * Optional visual-evidence flag for photographed pages with red pen annotations.
 * This is NOT OCR: it never changes recognized text and never reconstructs
 * hidden numeric dots or digits. Coordinates are from the same RGB source.
 */
export function detectRedAnnotationNearText(rgb,width,height,box,{
  scanWidth=165,redFractionThreshold=0.012,
}={}) {
  if(!(rgb instanceof Uint8Array) ||
     !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
     width<=0 || height<=0 || rgb.length!==width*height*3 ||
     !Array.isArray(box) || box.length!==4 || !box.every(Number.isFinite)) {
    return {detected:false,reason:'invalid_geometry'}
  }
  const x1=Math.max(0,Math.floor(box[0]))
  const x2=Math.min(width,Math.ceil(box[2]),x1+scanWidth)
  const y1=Math.max(0,Math.floor(box[1]))
  const y2=Math.min(height,Math.ceil(box[3]))
  if(x2<=x1 || y2<=y1)return {detected:false,reason:'empty_region'}
  let colored=0,total=0
  for(let y=y1;y<y2;y++){
    for(let x=x1;x<x2;x++){
      const at=(y*width+x)*3
      const r=rgb[at],g=rgb[at+1],b=rgb[at+2]
      if(r>80 && r-g>35 && r-b>46)colored++
      total++
    }
  }
  const fraction=colored/total
  const detected=colored>=15 && fraction>=redFractionThreshold
  return {detected,redPixelFraction:Math.round(fraction*10000)/10000,
    redPixelCount:colored,scannedPixelCount:total}
}
