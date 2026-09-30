"use client";

export function EmployeeForm({ action, confirmation, children }: {
  action: (form: FormData) => Promise<void>;
  confirmation: string;
  children: React.ReactNode;
}) {
  return <form action={action} className="data-form" onSubmit={event => {
    if (!window.confirm(confirmation)) event.preventDefault();
  }}>
    {children}
    <label className="check"><input type="checkbox" name="confirmed" value="yes" required />ვადასტურებ ამ ცვლილებას.</label>
  </form>;
}
