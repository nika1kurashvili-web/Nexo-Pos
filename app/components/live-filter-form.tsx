"use client";

import { useEffect, useRef, useTransition, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

/*
 * ფილტრის ფორმა, რომელიც ჩაწერისთანავე ეძებს (Enter საჭირო არ არის).
 * ტექსტურ ველებს 350 მწ-ით ვაყოვნებთ, არჩევანს/თარიღს ვაგზავნით მაშინვე.
 * ელემენტს data-clear ატრიბუტით ველები ეცარიელება და ძებნა ახლდება.
 */
export default function LiveFilterForm({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function go() {
    const form = formRef.current;
    if (!form) return;
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => {
      if (typeof value === "string" && value.trim()) params.set(key, value.trim());
    });
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function onChange(event: FormEvent<HTMLFormElement>) {
    const target = event.target as HTMLElement;
    if (timer.current) clearTimeout(timer.current);
    const isText =
      target instanceof HTMLInputElement &&
      ["text", "search", "number", ""].includes(target.type);
    if (isText) {
      timer.current = setTimeout(go, 350);
    } else {
      go();
    }
  }

  function onClick(event: MouseEvent<HTMLFormElement>) {
    const clear = (event.target as HTMLElement).closest("[data-clear]");
    if (!clear) return;
    event.preventDefault();
    if (timer.current) clearTimeout(timer.current);
    const form = formRef.current;
    form?.querySelectorAll("input, select").forEach((el) => {
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = false;
      else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = "";
    });
    go();
  }

  return (
    <form
      ref={formRef}
      method="get"
      className={className}
      onChange={onChange}
      onClick={onClick}
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        go();
      }}
      aria-busy={pending}
    >
      {children}
    </form>
  );
}
