/** Apply the plan's export branding after the content has been rendered. */
export function stampExport(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The export image could not be prepared.');
  const scale = Math.max(.5, Math.min(canvas.width, canvas.height) / 900);
  const fontSize = Math.max(10, Math.round(16 * scale));
  const pad = Math.max(8, Math.round(14 * scale));
  context.save();
  context.resetTransform();
  context.font = `500 ${fontSize}px Arial, sans-serif`;
  const text = 'Made with monogram';
  const textWidth = context.measureText(text).width;
  const width = textWidth + pad * 2;
  const height = fontSize + pad * 1.5;
  const x = Math.max(0, canvas.width - width - pad);
  const y = Math.max(0, canvas.height - height - pad);
  context.fillStyle = 'rgba(255,255,255,.92)';
  context.fillRect(x, y, width, height);
  context.fillStyle = '#323633';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(text, x + pad, y + height / 2);
  context.restore();
}

export async function brandPNG(source: string, watermark: boolean) {
  if (!watermark) return source;
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The export image could not be prepared.');
  context.drawImage(image, 0, 0);
  stampExport(canvas);
  return canvas.toDataURL('image/png');
}
