"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { matchImageFiles, type ImageTarget } from "@/lib/pos/product-images";
import { uploadImages, type UploadOutcome } from "@/lib/pos/image-upload";

const isImage = (f: File) => /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name) || f.type.startsWith("image/");

export default function ProductImagesUpload({ targets }: { targets: ImageTarget[] }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [outcomes, setOutcomes] = useState<UploadOutcome[] | null>(null);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  const match = useMemo(() => matchImageFiles(files.map((f) => f.name), targets, replace), [files, targets, replace]);

  const add = (list: FileList | File[] | null) => {
    if (!list) return;
    const picked = Array.from(list).filter(isImage);
    setOutcomes(null);
    setFiles(picked);
  };

  const start = async () => {
    if (busy || match.matched.length === 0) return;
    setBusy(true);
    setOutcomes(null);
    setProgress([0, match.matched.length]);
    const jobs = match.matched.map((m) => ({ kind: m.target.kind, id: m.target.id, file: files[m.index] }));
    try {
      const result = await uploadImages(jobs, (done, total) => setProgress([done, total]));
      setOutcomes(result);
      setFiles([]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const okCount = outcomes?.filter((o) => o.ok).length ?? 0;
  const failed = outcomes?.filter((o) => !o.ok) ?? [];
  const labelOf = (o: UploadOutcome) => targets.find((t) => t.id === o.id && t.kind === o.kind)?.label ?? o.id;

  return <section className="panel">
    <div
      className={`drop-zone${drag ? " drop-active" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
    >
      <p><strong>ჩააგდეთ ფოტოები აქ</strong> ან აირჩიეთ:</p>
      <div>
        <button type="button" className="button primary" disabled={busy} onClick={() => picker.current?.click()}>ფოტოების არჩევა</button>{" "}
        <button type="button" className="button secondary" disabled={busy} onClick={() => folder.current?.click()}>მთელი საქაღალდის არჩევა</button>
      </div>
      <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <input ref={folder} type="file" hidden multiple onChange={(e) => { add(e.target.files); e.target.value = ""; }}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
    </div>

    <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={busy} />ფოტოს მქონე პროდუქტებზეც ჩანაცვლება</label>

    {files.length > 0 && <div className="image-preview">
      <p><strong>არჩეულია {files.length} ფოტო.</strong> ავტომატურად მიება: <strong>{match.matched.length}</strong>
        {match.skippedExisting.length > 0 && <>, უკვე აქვთ ფოტო (გამოტოვდება): {match.skippedExisting.length}</>}
        {match.unmatched.length > 0 && <>, ვერ მოიძებნა: <strong>{match.unmatched.length}</strong></>}
        {match.ambiguous.length > 0 && <>, ორაზროვანია: {match.ambiguous.length}</>}
        {match.duplicates.length > 0 && <>, დუბლიკატი: {match.duplicates.length}</>}.</p>
      {match.unmatched.length > 0 && <details><summary>ვერ მოიძებნა პროდუქტი ({match.unmatched.length})</summary>
        <ul>{match.unmatched.slice(0, 200).map((u) => <li key={u.index}>{u.fileName}</li>)}</ul></details>}
      {match.ambiguous.length > 0 && <details><summary>ორაზროვანი სახელი ({match.ambiguous.length})</summary>
        <ul>{match.ambiguous.map((u) => <li key={u.index}>{u.fileName} → {u.candidates.join("; ")}</li>)}</ul></details>}
      {match.duplicates.length > 0 && <details><summary>ერთ პროდუქტზე ორი ფოტო ({match.duplicates.length})</summary>
        <ul>{match.duplicates.map((u) => <li key={u.index}>{u.fileName} (უკვე აღებულია: {u.of})</li>)}</ul></details>}
      {match.matched.length > 0 && <details><summary>რა მიება რას ({match.matched.length})</summary>
        <ul>{match.matched.slice(0, 300).map((m) => <li key={m.index}>{m.fileName} → {m.target.label}</li>)}</ul></details>}
      <div>
        <button type="button" className="button primary" disabled={busy || match.matched.length === 0} onClick={start}>
          {busy ? `იტვირთება ${progress[0]} / ${progress[1]}…` : `ატვირთვა (${match.matched.length})`}
        </button>{" "}
        {!busy && <button type="button" className="button secondary" onClick={() => setFiles([])}>გასუფთავება</button>}
      </div>
    </div>}

    {outcomes && <div role="status">
      <p className={failed.length ? "notice error" : "notice success"}>ატვირთულია: {okCount}{failed.length > 0 && <>, ვერ აიტვირთა: {failed.length}</>}.</p>
      {failed.length > 0 && <ul>{failed.map((o) => <li key={`${o.kind}-${o.id}`}>{labelOf(o)} — {o.reason}</li>)}</ul>}
    </div>}
  </section>;
}
