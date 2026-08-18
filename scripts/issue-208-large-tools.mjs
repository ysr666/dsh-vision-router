import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../index.js', import.meta.url)
let source = await readFile(file, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`)
  source = source.replace(before, after)
}

replaceOnce(
  'crop description',
  `        'Crop a pixel region (x1,y1,x2,y2 in ORIGINAL pixels) out of an image and write the ' +\n        'result as a PNG artifact for a closer look.',`,
  `        'Crop a pixel region (x1,y1,x2,y2 in ORIGINAL pixels) out of an image and write the ' +\n        'result as a PNG artifact for a closer look. Very large regions are rendered as a bounded ' +\n        'preview; crop a smaller ORIGINAL-pixel region when tiny details must be preserved.',`,
)

replaceOnce(
  'bounded crop execution',
  `        const sharp = await loadSharp()\n        const cropped = await sharp(bytes, { failOn: 'none' })\n          .extract({ left: box.x1, top: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 })\n          .png()\n          .toBuffer()\n        const target = await saveArtifact(\n          exec,\n          \`${'${artifactStem(args.image, `crop-${box.x1}-${box.y1}-${box.x2}-${box.y2}`)}'}.png\`,\n          cropped,\n        )\n        const meta = await sharp(cropped).metadata()\n        return JSON.stringify({\n          path: target,\n          width: meta.width ?? box.x2 - box.x1,\n          height: meta.height ?? box.y2 - box.y1,\n          bytes: cropped.length,\n        })`,
  `        const sharp = await loadSharp()\n        const sourceWidth = box.x2 - box.x1\n        const sourceHeight = box.y2 - box.y1\n        const preview = scaledDimensions(sourceWidth, sourceHeight, 4_000_000)\n        const releaseCrop = await defaultImageResourceGovernor.acquire(\n          estimateImageOperationBytes('crop', sourceWidth, sourceHeight),\n        )\n        let cropped\n        try {\n          let pipeline = sharp(bytes, { failOn: 'none' }).extract({\n            left: box.x1,\n            top: box.y1,\n            width: sourceWidth,\n            height: sourceHeight,\n          })\n          if (preview.scale !== 1) {\n            pipeline = pipeline.resize(preview.width, preview.height, { fit: 'fill' })\n          }\n          cropped = await pipeline.png().toBuffer()\n        } finally {\n          releaseCrop()\n        }\n        const target = await saveArtifact(\n          exec,\n          \`${'${artifactStem(args.image, `crop-${box.x1}-${box.y1}-${box.x2}-${box.y2}`)}'}.png\`,\n          cropped,\n        )\n        const meta = await sharp(cropped).metadata()\n        return JSON.stringify({\n          path: target,\n          width: meta.width ?? preview.width,\n          height: meta.height ?? preview.height,\n          bytes: cropped.length,\n          ...(preview.scale !== 1\n            ? {\n                preview: true,\n                sourceRegion: box,\n                sourceWidth,\n                sourceHeight,\n                scale: preview.scale,\n                advice: 'This was a bounded preview of a large crop. Use vision_crop again with a smaller ORIGINAL-pixel region for tiny details.',\n              }\n            : {}),\n        })`,
)

replaceOnce(
  'present pass through compressed input',
  `        const { bytes } = await readImageBytes(exec, args.image)\n        const sharp = await loadSharp()\n        const png = await sharp(bytes, { failOn: 'none' }).png().toBuffer()\n        const label =\n          typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim().slice(0, 200) : 'image'\n        const target = await saveArtifact(exec, \`${'${artifactStem(args.image, \'present\')}'}.png\`, png)\n        let attachment\n        try {\n          attachment = await attachments.saveImage({\n            data: png,\n            mediaType: 'image/png',\n            name: label,\n          })`,
  `        const { bytes, mediaType } = await readImageBytes(exec, args.image)\n        // Publishing is not a pixel-processing operation. Preserve the already\n        // admitted compressed image instead of decoding/re-encoding a 100MP\n        // JPEG/WebP/GIF into a potentially enormous PNG just to show it.\n        const label =\n          typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim().slice(0, 200) : 'image'\n        const extension =\n          mediaType === 'image/jpeg' ? 'jpg' :\n          mediaType === 'image/webp' ? 'webp' :\n          mediaType === 'image/gif' ? 'gif' : 'png'\n        const target = await saveArtifact(exec, \`${'${artifactStem(args.image, \'present\')}'}\.${'${extension}'}\`, bytes)\n        let attachment\n        try {\n          attachment = await attachments.saveImage({\n            data: bytes,\n            mediaType,\n            name: label,\n          })`,
)

source = source.replace(
  `  // #208 follow-up complete: session-visible paths use scoped memory; only\n  // session-less adapter boundaries use the ambiguity-safe facade.`,
  `  // #208 follow-up complete: session-visible paths use scoped memory; only\n  // session-less adapter boundaries use the ambiguity-safe facade.\n  // #208 large-tool follow-up complete: crop is bounded and presentation is compressed passthrough.`,
)

await writeFile(file, source)
console.log('issue 208 large-tool follow-up applied')
