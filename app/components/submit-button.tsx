"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingText, className }: {
  children: React.ReactNode;
  pendingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending} aria-disabled={pending}>
    {pending ? pendingText : children}
  </button>;
}
