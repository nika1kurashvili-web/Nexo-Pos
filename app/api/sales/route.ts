import { NextResponse } from "next/server";
import { submitSale } from "@/lib/pos/sale-submit";

export const dynamic = "force-dynamic";

// გაყიდვის გაგზავნა JSON-ით (ოფლაინ რიგიდან და ჩვეულებრივი გაფორმებიდან).
// ავტორიზაციას middleware ამოწმებს; ბაზის ფუნქცია მაინც ამოწმებს მოლარეს.
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400, headers });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400, headers });
  }
  const result = await submitSale(body as Record<string, unknown>);
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === "failed" ? 500 : 400, headers });
}
