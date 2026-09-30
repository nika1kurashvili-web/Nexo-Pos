"use client";

export function ReceiptPrintButton() {
  return (
    <button
      type="button"
      className="button receipt-print-button"
      onClick={() => window.print()}
    >
      ქვითრის დაბეჭდვა
    </button>
  );
}