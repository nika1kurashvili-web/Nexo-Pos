"use client";
import { createClient } from "@supabase/supabase-js";
import { prepareImageUploads, saveProductImages, type UploadRequest } from "@/app/(pos)/products/images/actions";
import { resizeImage } from "./image-resize";

export type UploadJob = { kind: "product" | "variant"; id: string; file: File };
export type UploadOutcome = { id: string; kind: "product" | "variant"; ok: boolean; reason?: string; url?: string };

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
    const requests: UploadRequest[] = ready.map((r) => ({ kind: r.job.kind, id: r.job.id, ext: r.image.ext }));
    let prep;
    try { prep = await prepareImageUploads(requests); } catch { prep = { ok: false, tickets: [], base: "" }; }
    const saved: { kind: "product" | "variant"; id: string; url: string }[] = [];
    let index = 0;
    const worker = async () => {
      while (index < ready.length) {
        const i = index++;
        const { job, image } = ready[i];
        const ticket = prep.tickets[i];
        if (!prep.ok || !ticket?.ok || !ticket.fullPath || !ticket.fullToken || !ticket.thumbPath || !ticket.thumbToken || !ticket.url) {
          outcomes.push({ id: job.id, kind: job.kind, ok: false, reason: "ბილეთი ვერ მოიცა" });
        } else {
          const [a, b] = await Promise.all([
            storage.storage.from(BUCKET).uploadToSignedUrl(ticket.fullPath, ticket.fullToken, image.full, { contentType: image.type, upsert: true }),
            storage.storage.from(BUCKET).uploadToSignedUrl(ticket.thumbPath, ticket.thumbToken, image.thumb, { contentType: image.type, upsert: true }),
          ]);
          if (a.error || b.error) outcomes.push({ id: job.id, kind: job.kind, ok: false, reason: "ატვირთვა ვერ შესრულდა" });
          else { saved.push({ kind: job.kind, id: job.id, url: ticket.url }); outcomes.push({ id: job.id, kind: job.kind, ok: true, url: ticket.url }); }
        }
        done++;
        onProgress(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ready.length) }, worker));

    // 3) ბმულების ჩაწერა ბაზაში
    if (saved.length > 0) {
      let result: { ok: boolean } = { ok: false };
      try { result = await saveProductImages(saved); } catch { /* ქვემოთ */ }
      if (!result.ok) {
        for (const s of saved) {
          const o = outcomes.find((x) => x.id === s.id && x.kind === s.kind);
          if (o) { o.ok = false; o.reason = "ბმული ვერ შეინახა (გაუშვით მიგრაცია)"; }
        }
      }
    }
  }
  return outcomes;
}
