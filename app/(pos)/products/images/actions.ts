"use server";

import { requireAdmin } from "@/lib/auth/server";
import { rpcClient } from "@/lib/pos/server";
import { safeAuthError } from "@/lib/auth/diagnostics";

const BUCKET = "product-images";
const supabaseUrl = () => (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UploadRequest = { kind: "product" | "variant"; id: string; ext: "webp" | "jpg"; extra?: boolean };
export type UploadTicket = {
  kind: "product" | "variant";
  id: string;
  ok: boolean;
  fullPath?: string;
  fullToken?: string;
  thumbPath?: string;
  thumbToken?: string;
  url?: string;
};

function valid(item: UploadRequest) {
  return (item.kind === "product" || item.kind === "variant") && uuidRe.test(item.id) && (item.ext === "webp" || item.ext === "jpg");
}

// ნაბიჯი 1: ადმინისთვის ერთჯერადი ატვირთვის ბილეთები (ფაილი პირდაპირ Supabase-ში ადის, POS სერვერზე არ გადის).
export async function prepareImageUploads(items: UploadRequest[]): Promise<{ ok: boolean; tickets: UploadTicket[]; base: string }> {
  await requireAdmin();
  const base = `${supabaseUrl()}/storage/v1/object/public/${BUCKET}`;
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) return { ok: false, tickets: [], base };
  const client = await rpcClient();
  const version = Date.now();
  const tickets: UploadTicket[] = [];
  for (const item of items) {
    if (!valid(item)) { tickets.push({ kind: item?.kind, id: item?.id, ok: false }); continue; }
    const dir = item.kind === "product" ? "p" : "v";
    // დამატებით ფოტოს უნიკალური სახელი აქვს, რომ ერთმანეთს არ გადააწეროს
    const stem = item.extra ? `${item.id.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}` : item.id.toLowerCase();
    const fullPath = `${dir}/${stem}.${item.ext}`;
    const thumbPath = `${dir}/${stem}_s.${item.ext}`;
    const [full, thumb] = await Promise.all([
      client.storage.from(BUCKET).createSignedUploadUrl(fullPath, { upsert: true }),
      client.storage.from(BUCKET).createSignedUploadUrl(thumbPath, { upsert: true }),
    ]);
    if (full.error || thumb.error || !full.data || !thumb.data) {
      console.error("[nexo-pos-images] sign", safeAuthError(full.error ?? thumb.error));
      tickets.push({ kind: item.kind, id: item.id, ok: false });
      continue;
    }
    tickets.push({
      kind: item.kind,
      id: item.id,
      ok: true,
      fullPath,
      fullToken: full.data.token,
      thumbPath,
      thumbToken: thumb.data.token,
      url: item.extra ? `${base}/${fullPath}` : `${base}/${fullPath}?v=${version}`,
    });
  }
  return { ok: true, tickets, base };
}

// ნაბიჯი 2: ატვირთვის შემდეგ ბმულის ჩაწერა პროდუქტზე (ან null = ფოტოს მოხსნა).
export async function saveProductImages(items: { kind: "product" | "variant"; id: string; url: string | null }[]): Promise<{ ok: boolean; saved: number }> {
  await requireAdmin();
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return { ok: false, saved: 0 };
  const client = await rpcClient();
  const { data, error } = await client.rpc("pos_set_product_images", { p_items: items });
  if (error) {
    console.error("[nexo-pos-images] save", safeAuthError(error));
    return { ok: false, saved: 0 };
  }
  return { ok: true, saved: Number(data) || 0 };
}

export async function removeProductImage(kind: "product" | "variant", id: string): Promise<boolean> {
  await requireAdmin();
  if (!valid({ kind, id, ext: "webp" })) return false;
  const result = await saveProductImages([{ kind, id, url: null }]);
  if (!result.ok) return false;
  // ძველი ფაილების წაშლა საცავიდან (თუ ვერ წაიშალა, არაფერი დაიკარგება: ბმული უკვე მოხსნილია)
  const client = await rpcClient();
  const dir = kind === "product" ? "p" : "v";
  const lower = id.toLowerCase();
  await client.storage.from(BUCKET).remove(["webp", "jpg"].flatMap((ext) => [`${dir}/${lower}.${ext}`, `${dir}/${lower}_s.${ext}`]));
  return true;
}

// დამატებითი ფოტოების სრული სია (მაქს. 6) პროდუქტზე/ვარიანტზე.
export async function saveProductExtras(items: { kind: "product" | "variant"; id: string; urls: string[] }[]): Promise<{ ok: boolean }> {
  await requireAdmin();
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return { ok: false };
  const client = await rpcClient();
  const { error } = await client.rpc("pos_set_product_extras", { p_items: items });
  if (error) {
    console.error("[nexo-pos-images] extras", safeAuthError(error));
    return { ok: false };
  }
  return { ok: true };
}

// დამატებითი ფოტოს მოხსნა: ჯერ სია განახლდება, შემდეგ ფაილები იშლება საცავიდან.
export async function removeExtraImage(kind: "product" | "variant", id: string, urls: string[], removeUrl: string): Promise<boolean> {
  await requireAdmin();
  if (!valid({ kind, id, ext: "webp" }) || !Array.isArray(urls) || !urls.includes(removeUrl)) return false;
  const next = urls.filter((u) => u !== removeUrl);
  const saved = await saveProductExtras([{ kind, id, urls: next }]);
  if (!saved.ok) return false;
  const prefix = `${supabaseUrl()}/storage/v1/object/public/${BUCKET}/`;
  if (removeUrl.startsWith(prefix)) {
    const path = removeUrl.slice(prefix.length).split("?")[0];
    const dir = kind === "product" ? "p" : "v";
    if (new RegExp(`^${dir}/${id.toLowerCase()}-[0-9a-f]{8}\\.(webp|jpg)$`).test(path)) {
      const client = await rpcClient();
      await client.storage.from(BUCKET).remove([path, path.replace(/\.(webp|jpg)$/, "_s.$1")]);
    }
  }
  return true;
}
