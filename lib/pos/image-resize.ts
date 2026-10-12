// ბრაუზერში ფოტოს დაპატარავება ატვირთვამდე: დიდი ფოტო (მაგ. 5 MB) იქცევა ~60-150 KB ფაილად,
// ამიტომ ატვირთვა სწრაფია და საცავი/ტრაფიკი მცირდება.
export type ResizedImage = { full: Blob; thumb: Blob; ext: "webp" | "jpg"; type: "image/webp" | "image/jpeg" };

const MAX_INPUT_BYTES = 30 * 1024 * 1024;

async function render(bitmap: ImageBitmap, max: number, type: string, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff"; // გამჭვირვალე PNG-ს თეთრი ფონი
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

export async function resizeImage(file: File): Promise<ResizedImage> {
  if (file.size > MAX_INPUT_BYTES) throw new Error("TOO_BIG");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("UNREADABLE");
  }
  try {
    let type: "image/webp" | "image/jpeg" = "image/webp";
    let full = await render(bitmap, 1000, type, 0.82);
    // ზოგ ბრაუზერს webp-ის გაკეთება არ შეუძლია: მაშინ jpeg
    if (!full || full.type !== "image/webp") {
      type = "image/jpeg";
      full = await render(bitmap, 1000, type, 0.85);
    }
    const thumb = await render(bitmap, 240, type, 0.8);
    if (!full || !thumb) throw new Error("UNREADABLE");
    if (full.size > 1024 * 1024) throw new Error("TOO_BIG");
    return { full, thumb, type, ext: type === "image/webp" ? "webp" : "jpg" };
  } finally {
    bitmap.close();
  }
}
