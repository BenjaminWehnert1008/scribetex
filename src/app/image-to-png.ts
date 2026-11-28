/**
 * Re-encodes a picture as PNG with the browser's own decoder, for formats
 * pdfLaTeX cannot include (GIF, BMP, WebP; TIFF where the browser reads it).
 * Returns null when the browser cannot decode the picture.
 */
export async function imageToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return null;
  }
  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) return null;
    let blob: Blob | null;
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    bitmap.close();
  }
}
