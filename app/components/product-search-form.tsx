"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

type Props = {
  q: string;
  cat: string;
  all: boolean;
  categories: string[];
};

/*
 * ძებნა ჩაწერისთანავე: Enter-ის დაჭერა საჭირო არ არის.
 * ტექსტის ცვლილებას 300 მწ-ით ვაყოვნებთ, კატეგორიას და ჩეკბოქსს ვუყენებთ მაშინვე.
 */
export default function ProductSearchForm({ q, cat, all, categories }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState(q);
  const [category, setCategory] = useState(cat);
  const [showAll, setShowAll] = useState(all);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function go(nextText: string, nextCat: string, nextAll: boolean) {
    const params = new URLSearchParams();
    const trimmed = nextText.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextCat) params.set("cat", nextCat);
    if (nextAll) params.set("all", "1");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <form
      method="get"
      className="data-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        go(text, category, showAll);
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
            timer.current = setTimeout(() => go(value, category, showAll), 300);
          }}
        />
      </label>
      <label>
        კატეგორია
        <select
          name="cat"
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            go(text, event.target.value, showAll);
          }}
        >
          <option value="">ყველა</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          <option value="none">კატეგორიის გარეშე</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          name="all"
          value="1"
          checked={showAll}
          onChange={(event) => {
            setShowAll(event.target.checked);
            go(text, category, event.target.checked);
          }}
        />
        გაუქმებულებიც
      </label>
      <div>
        <button type="submit" className="button primary">ძებნა</button>{" "}
        <Link href="/products" className="button secondary" onClick={() => { setText(""); setCategory(""); setShowAll(false); }}>
          გასუფთავება
        </Link>
        {pending && <span className="muted"> ვეძებ…</span>}
      </div>
    </form>
  );
}
