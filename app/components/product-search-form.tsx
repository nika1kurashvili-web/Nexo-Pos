"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/*
 * ზოგადი ძებნა ჩაწერისთანავე (Enter საჭირო არ არის). სვეტების ფილტრებს არ ეხება:
 * სხვა პარამეტრები ინახება. „გასუფთავება“ ყველა ფილტრს აქრობს.
 */
export default function ProductSearchForm({ q }: { q: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [text, setText] = useState(q);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function go(value: string) {
    const params = new URLSearchParams(search.toString());
    if (params.get("all") === "1" && !params.get("status")) params.set("status", "all");
    params.delete("all");
    const trimmed = value.trim();
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <form
      method="get"
      className="data-form search-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        go(text);
      }}
    >
      <label>
        ძებნა (სახელი ან კოდი)
        <input
          name="q"
          value={text}
          maxLength={100}
          autoComplete="off"
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => go(value), 300);
          }}
        />
      </label>
      <div>
        <button type="submit" className="button primary">ძებნა</button>{" "}
        <Link href="/products" className="button secondary" onClick={() => setText("")}>
          ყველა ფილტრის გასუფთავება
        </Link>
        {pending && <span className="muted"> ვეძებ…</span>}
      </div>
    </form>
  );
}
