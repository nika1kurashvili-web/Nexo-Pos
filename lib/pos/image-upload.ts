"use client";
import { createClient } from "@supabase/supabase-js";
import { prepareImageUploads, saveProductExtras, saveProductImages, type UploadRequest } from "@/app/(pos)/products/images/actions";
import { resizeImage } from "./image-resize";
import { applyExtras } from "./product-images";

// slot 1 = მთავარი ფოტო, 2..7 = დამატებითი. extras = ამ პროდუქტის ამჟამინდელი დამატებითი ფოტოების სია.
export type UploadJob = { kind: "product" | "variant"; id: string; file: File; slot?: number; extras?: string[] };
export type UploadOutcome = { id: string; kind: "product" | "variant"; ok: boolean; reason?: string; url?: string; slot?: number };

const BUCKET = "product-images";
const CHUNK = 10;
const PARALLEL = 3;

function storageClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // ცალკე კლიენტი: ტოკენი ბილეთშია, სესია/ქუქი არ სჭირდება
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export async function uploadImages(jobs: UploadJob[], onProgress: (done: number, total: number) => void): Promise<UploadOutcome[]> {
  const storage = storageClient();
  const outcomes: UploadOutcome[] = [];
  const extraState = new Map<string, string[]>();
  let done = 0;
  if (!storage) {
    return jobs.map((j) => ({ id: j.id, kind: j.kind, ok: false, reason: "კონფიგურაცია" }));
  }
  for (let start = 0; start < jobs.length; start += CHUNK) {
    const chunk = jobs.slice(start, start + CHUNK);
    // 1) დაპატარავება ბრაუზერში
    const resized = await Promise.all(chunk.map(async (job) => {
      try { return { job, image: await resizeImage(job.file) }; }
      catch (e) { return { job, error: e instanceof Error && e.message === "TOO_BIG" ? "ფაილი ძალიან დიდია" : "ფაილი ვერ იკითხება (HEIC?)" }; }
    }));
    const ready = resized.filter((r): r is { job: UploadJob; image: Awaited<ReturnType<typeof resizeImage>> } => "image" in r);
    for (const r of resized) if ("error" in r) { outcomes.push({ id: r.job.id, kind: r.job.kind, ok: false, reason: r.error }); done++; }
    if (ready.length === 0) { onProgress(done, jobs.length); continue; }

    // 2) ბილეთები სერვერიდან
    const requests: UploadRequest[] = ready.map((r) => ({ kind: r.job.kind, id: r.job.id, ext: r.image.ext, extra: (r.job.slot ?? 1) > 1 }));
    let prep;
    try { prep = await prepareImageUploads(requests); } catch { prep = { ok: false, tickets: [], base: "" }; }
    const saved: { kind: "product" | "variant"; id: string; url: string; slot: number }[] = [];
    let index = 0;
    const worker = async () => {
      while (index < ready.length) {
        const i = index++;
        const { job, image } = ready[i];
        const ticket = prep.tickets[i];
        if (!prep.ok || !ticket?.ok || !ticket.fullPath || !ticket.fullToken || !ticket.thumbPath || !ticket.thumbToken || !ticket.url) {
          outcomes.push({ id: job.id, kind: job.kind, ok: false, reason: "ბილეთი ვერ მოიცა", slot: job.slot });
        } else {
          const [a, b] = await Promise.all([
            storage.storage.from(BUCKET).uploadToSignedUrl(ticket.fullPath, ticket.fullToken, image.full, { contentType: image.type, upsert: true }),
            storage.storage.from(BUCKET).uploadToSignedUrl(ticket.thumbPath, ticket.thumbToken, image.thumb, { contentType: image.type, upsert: true }),
          ]);
          if (a.error || b.error) outcomes.push({ id: job.id, kind: job.kind, ok: false, reason: "ატვირთვა ვერ შესრულდა", slot: job.slot });
          else { saved.push({ kind: job.kind, id: job.id, url: ticket.url, slot: job.slot ?? 1 }); outcomes.push({ id: job.id, kind: job.kind, ok: true, url: ticket.url, slot: job.slot }); }
        }
        done++;
        onProgress(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ready.length) }, worker));

    // 3) ბმულების ჩაწერა ბაზაში: მთავარი ფოტო ცალკე, დამატებითი ფოტოების სია პროდუქტზე ერთიანად
    if (saved.length > 0) {
      const fail = (items: typeof saved, reason: string) => {
        for (const sv of items) {
          const o = outcomes.find((x) => x.id === sv.id && x.kind === sv.kind && (x.slot ?? 1) === sv.slot);
          if (o) { o.ok = false; o.reason = reason; }
        }
      };
      const mains = saved.filter((x) => x.slot === 1);
      if (mains.length > 0) {
        let result: { ok: boolean } = { ok: false };
        try { result = await saveProductImages(mains.map(({ kind, id, url }) => ({ kind, id, url }))); } catch { /* ქვემოთ */ }
        if (!result.ok) fail(mains, "ბმული ვერ შეინახა (გაუშვით მიგრაცია)");
      }
      const extras = saved.filter((x) => x.slot > 1);
      if (extras.length > 0) {
        const groups = new Map<string, typeof saved>();
        for (const x of extras) groups.set(`${x.kind}:${x.id}`, [...(groups.get(`${x.kind}:${x.id}`) ?? []), x]);
        const payload = [...groups.entries()].map(([key, list]) => {
          const base = extraState.get(key) ?? chunk.find((c) => `${c.kind}:${c.id}` === key)?.extras ?? [];
          const urls = applyExtras(base, list.map((x) => ({ slot: x.slot, url: x.url })));
          return { kind: list[0].kind, id: list[0].id, urls, key };
        });
        let result: { ok: boolean } = { ok: false };
        try { result = await saveProductExtras(payload.map(({ kind, id, urls }) => ({ kind, id, urls }))); } catch { /* ქვემოთ */ }
        if (!result.ok) fail(extras, "ბმული ვერ შეინახა (გაუშვით მიგრაცია 202610120002)");
        else for (const p of payload) extraState.set(p.key, p.urls);
      }
    }
  }
  return outcomes;
}
