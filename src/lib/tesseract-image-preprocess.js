// Optional local-only subtitle recovery, entered only after weak Tesseract OCR.
// Derives one lower-region greyscale crop without storing the source image.
export async function prepareTesseractSubtitleRetry(bytes, {
  loadSharp, signal, remainingMs = 0,
} = {}) {
  if (signal?.aborted || remainingMs < 900 || typeof loadSharp !== 'function') return null
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 24 * 1024 * 1024) return null
  const sharp = await loadSharp()
  if (signal?.aborted) return null
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 16_000_000, animated: false })
  const metadata = await image.metadata()
  const width = metadata.width, height = metadata.height
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
    width < 120 || height < 120 || width * height > 16_000_000) return null
  const top = Math.floor(height * 0.55)
  const crop = { left: 0, top, width, height: height - top }
  const sample = await sharp(bytes, { failOn: 'error', limitInputPixels: 16_000_000, animated: false })
    .extract(crop).resize(64, 32, { fit: 'fill' }).grayscale().raw().toBuffer()
  if (signal?.aborted) return null
  const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length
  // Invert only when the actual subtitle region is predominantly dark.
  const inverted = mean < 108
  const scale = Math.min(3.2, 1000 / width, 1500 / crop.height)
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(crop.height * scale))
  let pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 16_000_000, animated: false })
    .extract(crop).resize(outWidth, outHeight).grayscale().normalize()
  if (inverted) pipeline = pipeline.negate()
  const prepared = await pipeline.png().toBuffer()
  if (signal?.aborted) return null
  if (prepared.length > 16 * 1024 * 1024) return null
  return {
    bytes: prepared, variant: inverted ? 'subtitle-inverted' : 'subtitle-grayscale',
  }
}
