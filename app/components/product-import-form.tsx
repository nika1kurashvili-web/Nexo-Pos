"use client";

import { useRef, useState, useTransition } from "react";
import { importProducts } from "@/app/(pos)/products/actions";
import type { ImportPlan, ProductChange } from "@/lib/pos/product-import";

const labels: Record<string, string> = {
  name: "სახელი", variant_name: "ვარიანტი", sku: "ბარკოდი", price: "გასაყიდი ფასი",
  cost: "შესყიდვის ფასი", stock: "მარაგი", active: "სტატუსი",
};

function describe(change: ProductChange) {
  const parts = Object.entries(change.set).map(([key, value]) => {
    if (key === "active") return `სტატუსი → ${value ? "აქტიური" : "გაუქმებული"}`;
    const was = (change.was as Record<string, string | undefined>)[key];
    if (change.op === "create") return `${labels[key]}: ${String(value) || "—"}`;
    return `${labels[key]}: ${was === undefined || was === "" ? "—" : was} → ${String(value) === "" ? "—" : String(value)}`;
  });
  return parts.join(" · ");
}

export default function ProductImportForm({ requestId }: { requestId: string }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [parsing, startParse] = useTransition();

  function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setMessage("აირჩიეთ Excel ფაილი.");
    setMessage(null);
    setPlan(null);
    startParse(async () => {
      try {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch("/products/parse", { method: "POST", body });
        const data = await response.json();
        if (!response.ok) return setMessage(data.error ?? "ფაილის წაკითხვა ვერ მოხერხდა.");
        setPlan(data as ImportPlan);
      } catch {
        setMessage("ფაილის წაკითხვა ვერ მოხერხდა. სცადეთ ხელახლა.");
      }
    });
  }

  const created = plan?.changes.filter((c) => c.op === "create").length ?? 0;
  const updated = (plan?.changes.length ?? 0) - created;
  const blocked = (plan?.errors.length ?? 0) > 0;

  return (
    <>
      <section className="panel">
        <h2>1. აირჩიეთ ფაილი</h2>
        <p className="muted">გამოიყენეთ ჩამოტვირთული ფაილი: <a href="/products/export">პროდუქტების Excel-ის ჩამოტვირთვა</a>.</p>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" />{" "}
        <button type="button" className="button primary" onClick={upload} disabled={parsing}>
          {parsing ? "მოწმდება…" : "შემოწმება"}
        </button>
        {message && <p className="notice error" role="alert">{message}</p>}
      </section>

      {plan && (
        <section className="panel">
          <h2>2. გადახედვა</h2>
          <p>
            შეიცვლება: <strong>{updated}</strong> · ახალი პროდუქტი: <strong>{created}</strong> · უცვლელი: {plan.unchanged}
            {blocked && <> · <strong className="text-bad">შეცდომა: {plan.errors.length}</strong></>}
          </p>

          {plan.errors.length > 0 && (
            <div className="notice error" role="alert">
              <strong>შეასწორეთ ფაილი და ატვირთეთ ხელახლა:</strong>
              <ul>{plan.errors.slice(0, 50).map((e, i) => <li key={i}>სტრიქონი {e.row}: {e.message}</li>)}</ul>
              {plan.errors.length > 50 && <p>… და კიდევ {plan.errors.length - 50} შეცდომა.</p>}
            </div>
          )}
          {plan.warnings.length > 0 && (
            <ul className="muted">{plan.warnings.slice(0, 20).map((w, i) => <li key={i}>სტრიქონი {w.row}: {w.message}</li>)}</ul>
          )}

          {plan.changes.length > 0 && (
            <div className="table-scroll"><table className="products-table">
              <thead><tr><th scope="col">სტრიქონი</th><th scope="col">ქმედება</th><th scope="col">პროდუქტი</th><th scope="col">ცვლილება</th></tr></thead>
              <tbody>{plan.changes.map((c) => (
                <tr key={c.row}>
                  <td>{c.row}</td>
                  <td>{c.op === "create" ? "ახალი" : "ცვლილება"}</td>
                  <td><strong>{c.label}</strong></td>
                  <td>{describe(c)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          {plan.changes.length === 0 && !blocked && <p className="muted">ცვლილება არ არის: ფაილი სისტემის მონაცემებს ემთხვევა.</p>}

          {plan.changes.length > 0 && (
            <form action={importProducts}>
              <input type="hidden" name="request_id" value={requestId} />
              <input type="hidden" name="changes" value={JSON.stringify(plan.changes)} />
              <button type="submit" className="button primary" disabled={blocked}>
                დადასტურება და შენახვა ({plan.changes.length})
              </button>
              {blocked && <span className="muted"> — ჯერ შეასწორეთ შეცდომები</span>}
            </form>
          )}
        </section>
      )}
    </>
  );
}
