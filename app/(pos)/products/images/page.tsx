import Link from "next/link";
import { requireAdmin } from "@/lib/auth/server";
import { posClient } from "@/lib/pos/server";
import { loadImageMap } from "@/lib/pos/product-images-load";
import { buildImageTargets } from "@/lib/pos/product-images";
import ProductImagesUpload from "@/app/components/product-images-upload";

export const dynamic = "force-dynamic";

export default async function ProductImagesPage() {
  await requireAdmin();
  const client = await posClient();
  const [overview, images] = await Promise.all([client.rpc("pos_products_overview"), loadImageMap(client)]);
  const items = overview.data ?? [];
  const targets = buildImageTargets(items, (kind, id) => images.map.has(`${kind}:${id}`), (kind, id) => images.extras.get(`${kind}:${id}`)?.length ?? 0);
  const without = targets.filter((t) => !t.hasImage);

  return <>
    <div className="analytics-head">
      <h1>პროდუქტების ფოტოები</h1>
      <Link href="/products" className="button secondary">← პროდუქტებზე</Link>
    </div>
    {!images.ready && <p className="notice error" role="alert">ფოტოების სვეტი ვერ მოიძებნა. გაუშვით მიგრაცია 202610120001 Supabase-ში.</p>}

    {images.ready && !images.extrasReady && <p className="notice error" role="alert">დამატებითი ფოტოებისთვის გაუშვით მიგრაცია 202610120002 Supabase-ში.</p>}

    <section className="panel">
      <h2>როგორ მუშაობს</h2>
      <ol>
        <li>დაარქვით თითო ფოტოს <strong>პროდუქტის ბარკოდი (კოდი)</strong> ან <strong>პროდუქტის ზუსტი სახელი</strong>. მაგ.: <code>4860001234567.jpg</code> ან <code>საფეხურის დამცავი.png</code>.</li>
        <li>ვარიანტიან პროდუქტზე დაარქვით <code>პროდუქტი ვარიანტი</code> (მაგ. <code>მაისური წითელი.jpg</code>) ან ვარიანტის კოდი. ფოტო, რომელსაც მხოლოდ პროდუქტის სახელი ექნება, ყველა ვარიანტზე გამოჩნდება.</li>
        <li>ჩააგდეთ ყველა ფოტო ერთად ქვემოთ (ან აირჩიეთ მთელი საქაღალდე). პროგრამა თვითონ მიაბამს, აჩვენებს რა მიება და რა ვერ მოიძებნა, და დაგელოდებათ თქვენს დადასტურებას.</li>
      </ol>
      <p><strong>რამდენიმე ფოტო ერთ პროდუქტზე (მაქს. 7):</strong> პირველ (მთავარ) ფოტოს დაარქვით ჩვეულებრივი სახელი, დანარჩენებს დააბოლოვეთ <code>-2</code>, <code>-3</code> … <code>-7</code>. მაგ.: <code>4860001234567.jpg</code> (მთავარი), <code>4860001234567-2.jpg</code>, <code>4860001234567-3.jpg</code>. მთავარი ფოტო ჩანს გაყიდვის ეკრანზე, დანარჩენი — პროდუქტების სიაში „ფოტოები“-ზე დაჭერით და სხვა საიტებისთვის.</p>
      <p className="muted">ფოტო ავტომატურად დაპატარავდება (მაქს. 1000 პიქსელი, დაახლ. 100 KB), ამიტომ დიდი ფოტოც შეგიძლიათ ატვირთოთ. სახელში ზომას, ტირეს, ინტერვალს და დიდ/პატარა ასოს მნიშვნელობა არ აქვს.</p>
    </section>

    <ProductImagesUpload targets={targets} extras={Object.fromEntries(images.extras)} />

    <section className="panel">
      <details>
        <summary><strong>ფოტოს გარეშე: {without.length}</strong> / სულ {targets.length}</summary>
        {without.length === 0 ? <p className="muted">ყველა პროდუქტს აქვს ფოტო.</p> :
          <ul>{without.slice(0, 500).map((t) => <li key={`${t.kind}-${t.id}`}>{t.label}{t.sku && <span className="muted"> ({t.sku})</span>}</li>)}</ul>}
        {without.length > 500 && <p className="muted">ნაჩვენებია პირველი 500.</p>}
      </details>
    </section>
  </>;
}
