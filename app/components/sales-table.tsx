"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { ReturnStatusBadge } from "@/app/components/return-status-badge";
import type { ReturnStatus } from "@/lib/pos/return-status";

export type SalesTableItem = { name: string; sku: string; qty: string; price: string; total: string };
export type SalesTableRow = {
  id: string;
  number: number;
  day: string;
  time: string;
  cashier: string;
  wholesale: boolean;
  customer: string;
  tracking: string;
  warranty: string;
  total: string;
  paid: string;
  debt: string;
  hasDebt: boolean;
  returnStatus: ReturnStatus;
  items: SalesTableItem[];
};

export default function SalesTable({ rows }: { rows: SalesTableRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const allOpen = rows.length > 0 && open.size === rows.length;

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {rows.length > 0 && (
        <div className="sales-expand-bar">
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((row) => row.id)))}
          >
            {allOpen ? "ყველას ჩაკეცვა" : "ყველას გახსნა"}
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="ledger-table sales-table">
          <thead>
            <tr>
              <th><span className="sr-only">გახსნა</span></th>
              <th>№</th>
              <th>თარიღი</th>
              <th>მოლარე</th>
              <th>კლიენტი</th>
              <th>თრექინგი</th>
              <th>საგარანტიო</th>
              <th className="num">სულ</th>
              <th className="num">გადახდილი</th>
              <th className="num">დავალიანება</th>
              <th>დაბრუნება</th>
              <th><span className="sr-only">მოქმედება</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = open.has(row.id);
              return (
                <Fragment key={row.id}>
                  <tr className={isOpen ? "sale-row is-open" : "sale-row"}>
                    <td>
                      <button
                        type="button"
                        className="expand-btn"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "პროდუქტების დამალვა" : "პროდუქტების ჩვენება"}
                        onClick={() => toggle(row.id)}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </td>
                    <td>
                      <Link href={`/sales/${row.id}`} className="row-id">#{row.number}</Link>
                    </td>
                    <td>
                      <span className="cell-two">
                        {row.day}
                        <small>{row.time}</small>
                      </span>
                    </td>
                    <td>{row.cashier}</td>
                    <td>
                      {row.wholesale ? (
                        <span className="cell-two">
                          {row.customer}
                          <small>საბითუმო</small>
                        </span>
                      ) : (
                        <span className="muted">საცალო</span>
                      )}
                    </td>
                    <td>{row.tracking ? <span className="code">{row.tracking}</span> : <span className="muted">—</span>}</td>
                    <td>{row.warranty ? <span className="code">{row.warranty}</span> : <span className="muted">—</span>}</td>
                    <td className="num"><strong>{row.total}</strong></td>
                    <td className="num">{row.paid}</td>
                    <td className={row.hasDebt ? "num text-neg" : "num muted"}>{row.debt}</td>
                    <td><ReturnStatusBadge status={row.returnStatus} /></td>
                    <td className="row-action">
                      <Link href={`/sales/${row.id}`} className="row-link">დეტალები</Link>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="sale-items-row">
                      <td></td>
                      <td colSpan={11}>
                        {row.items.length === 0 ? (
                          <span className="muted">პროდუქტები ვერ მოიძებნა.</span>
                        ) : (
                          <table className="sale-items">
                            <thead>
                              <tr>
                                <th>კოდი</th>
                                <th>პროდუქტი</th>
                                <th className="num">რაოდ.</th>
                                <th className="num">ფასი</th>
                                <th className="num">ჯამი</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.items.map((item, index) => (
                                <tr key={index}>
                                  <td>{item.sku || "—"}</td>
                                  <td>{item.name}</td>
                                  <td className="num">{item.qty}</td>
                                  <td className="num">{item.price}</td>
                                  <td className="num">{item.total}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
