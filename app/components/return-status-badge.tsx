import { RETURN_STATUS_LABEL, type ReturnStatus } from "@/lib/pos/return-status";

export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  if (status === "none") return null;
  return <span className={`badge badge-return-${status}`}>{RETURN_STATUS_LABEL[status]}</span>;
}
