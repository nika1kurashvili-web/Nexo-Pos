"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_PHOTOS, thumbUrl } from "@/lib/pos/product-images";
import { uploadImages } from "@/lib/pos/image-upload";
import { removeExtraImage, removeProductImage } from "@/app/(pos)/products/images/actions";

type Props = { kind: "product" | "variant"; id: string; url: string | null; inherited?: boolean; extras?: string[] };

export default function ProductImageCell({ kind, id, url, inherited, extras = [] }: Props) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<number>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = !!url && !inherited;
  const total = (own ? 1 : 0) + extras.length;

  const choose = (slot: number) => {
    if (busy) return;
    target.current = slot;
    input.current?.click();
  };

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const slot = target.current;
      const [result] = await uploadImages([{ kind, id, file, slot, extras }], () => undefined);
      if (!result?.ok) setError(result?.reason ?? "ვერ აიტვირთა");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const removeMain = async () => {
    if (busy || !window.confirm("წავშალო მთავარი ფოტო?")) return;
    setBusy(true);
    try {
      if (await removeProductImage(kind, id)) router.refresh();
      else setError("ვერ წაიშალა");
    } finally {
      setBusy(false);
    }
  };

  const removeExtra = async (extraUrl: string) => {
    if (busy || !window.confirm("წავშალო ფოტო?")) return;
    setBusy(true);
    try {
      if (await removeExtraImage(kind, id, extras, extraUrl)) router.refresh();
      else setError("ვერ წაიშალა");
    } finally {
      setBusy(false);
    }
  };

  const thumb = (src: string, dim = false) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={thumbUrl(src)} alt="" width={44} height={44} loading="lazy" className={`img-thumb${dim ? " img-inherited" : ""}`} onError={(e) => { if (e.currentTarget.src !== src) e.currentTarget.src = src; }} />;

  return <div className="img-cell">
    <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
    {url ? thumb(url, inherited) : <span className="img-thumb img-empty" aria-hidden="true">📷</span>}
    <button type="button" className="button secondary img-btn" disabled={busy} onClick={() => choose(1)}>{busy ? "…" : own ? "შეცვლა" : "ატვირთვა"}</button>
    {own && <button type="button" className="button secondary img-btn" disabled={busy} onClick={removeMain} aria-label="მთავარი ფოტოს წაშლა">✕</button>}
    {error && <span className="muted" role="alert">{error}</span>}
    {own && <details className="img-gallery">
      <summary>ფოტოები {total}/{MAX_PHOTOS}</summary>
      <div className="img-gallery-grid">
        {extras.map((extra, i) => <div key={extra} className="img-slot">
          {thumb(extra)}
          <span className="img-slot-actions">
            <button type="button" className="button secondary img-btn" disabled={busy} onClick={() => choose(i + 2)}>შეცვლა</button>
            <button type="button" className="button secondary img-btn" disabled={busy} onClick={() => void removeExtra(extra)} aria-label="ფოტოს წაშლა">✕</button>
          </span>
        </div>)}
        {total < MAX_PHOTOS && <button type="button" className="button secondary img-add" disabled={busy} onClick={() => choose(extras.length + 2)}>+ დამატება</button>}
      </div>
    </details>}
  </div>;
}
