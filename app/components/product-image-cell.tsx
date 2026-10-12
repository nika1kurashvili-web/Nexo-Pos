"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { thumbUrl } from "@/lib/pos/product-images";
import { uploadImages } from "@/lib/pos/image-upload";
import { removeProductImage } from "@/app/(pos)/products/images/actions";

export default function ProductImageCell({ kind, id, url, inherited }: { kind: "product" | "variant"; id: string; url: string | null; inherited?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const [result] = await uploadImages([{ kind, id, file }], () => undefined);
      if (!result?.ok) setError(result?.reason ?? "ვერ აიტვირთა");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !window.confirm("წავშალო ფოტო?")) return;
    setBusy(true);
    try {
      if (await removeProductImage(kind, id)) router.refresh();
      else setError("ვერ წაიშალა");
    } finally {
      setBusy(false);
    }
  };

  return <div className="img-cell">
    {url
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={thumbUrl(url)} alt="" width={44} height={44} loading="lazy" className={`img-thumb${inherited ? " img-inherited" : ""}`} onError={(e) => { if (e.currentTarget.src !== url) e.currentTarget.src = url; }} />
      : <span className="img-thumb img-empty" aria-hidden="true">📷</span>}
    <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
    <button type="button" className="button secondary img-btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? "…" : url && !inherited ? "შეცვლა" : "ატვირთვა"}</button>
    {url && !inherited && <button type="button" className="button secondary img-btn" disabled={busy} onClick={remove} aria-label="ფოტოს წაშლა">✕</button>}
    {error && <span className="muted" role="alert">{error}</span>}
  </div>;
}
