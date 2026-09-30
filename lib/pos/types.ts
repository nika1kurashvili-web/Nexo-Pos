export type Decimal = string | number;
export type RegisterState = {
  register_id: string; register_name: string; register_active: boolean;
  session_id: string | null; cashier_id: string | null; cashier_name: string | null;
  opened_at: string | null; opening_cash: Decimal | null; cash_payments: Decimal | null;
  expected_cash: Decimal | null; is_own: boolean; can_close: boolean;
};
export type RegisterReport = {
  registers: { id: string; name: string }[];
  cashiers: { id: string; full_name: string }[];
  sessions: (RegisterSession & { register_name: string; cashier_name: string; expected_cash: Decimal | null })[];
};
type Stamp = { created_at: string; updated_at: string };
export type Customer = Stamp & { id: string; name: string; tax_code: string | null; phone: string | null; address: string | null; email: string | null; notes: string | null; active: boolean };
export type Register = Stamp & { id: string; name: string; active: boolean };
export type PaymentMethod = Stamp & { code: string; name: string; active: boolean };
export type RegisterSession = { id: string; register_id: string; cashier_id: string; opened_at: string; opening_cash: Decimal; closed_at: string | null; expected_closing_cash: Decimal | null; actual_closing_cash: Decimal | null; cash_difference: Decimal | null; closing_note: string | null; status: "open" | "closed" };
export type CustomerPrice = Stamp & { id: string; customer_id: string; product_id: string | number | null; variant_id: string | number | null; price: Decimal };
export type Payment = { id: string; request_id: string; request_fingerprint: string | null; sale_id: string; session_id: string; received_by: string; method_code: string; method_name: string; kind: "sale_payment" | "repayment"; amount: Decimal; created_at: string };
export type Sale = { id: string; sale_number: number; request_id: string; request_fingerprint: string; cashier_id: string; cashier_name: string; session_id: string; sale_type: "retail" | "wholesale"; customer_id: string | null; customer_name: string | null; customer_tax_code: string | null; tracking_code: string | null; subtotal: Decimal; discount_total: Decimal; total: Decimal; paid_total: Decimal; debt_amount: Decimal; status: "completed"; created_at: string };
export type SaleItem = { id: string; sale_id: string; line_number: number; target_kind: "product" | "variant"; product_id: string | number | null; variant_id: string | number | null; sku: string | null; product_name: string; variant_name: string | null; base_unit_price: Decimal; adjusted_unit_price: Decimal; quantity: Decimal; discount_percent: Decimal; final_unit_price: Decimal; line_total: Decimal; created_at: string };
export type CustomerTransaction = { id: string; customer_id: string; sale_id: string; payment_id: string | null; kind: "sale_charge" | "sale_payment" | "repayment"; amount: Decimal; created_at: string };
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };
export type PosTables = {
  pos_business_customers: Table<Customer>;
  pos_registers: Table<Register>;
  pos_payment_methods: Table<PaymentMethod>;
  pos_customer_prices: Table<CustomerPrice>;
  pos_register_sessions: Table<RegisterSession>;
  pos_sales: Table<Sale>;
  pos_sale_items: Table<SaleItem>;
  pos_payments: Table<Payment>;
  pos_customer_transactions: Table<CustomerTransaction>;
};
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type PosFunctions = {
  pos_register_state: { Args: Record<string, never>; Returns: RegisterState[] };
  pos_register_session_report: { Args: { p_from?: string | null; p_to?: string | null; p_register?: string | null; p_cashier?: string | null; p_status?: string | null }; Returns: RegisterReport };
  pos_import_customer_prices: { Args: { p_customer: string; p_rows: Json }; Returns: number };
  pos_customer_balance: { Args: { p_customer: string }; Returns: number };
  pos_open_register: { Args: { p_register: string; p_cash: string }; Returns: string };
  pos_close_register: { Args: { p_session: string; p_actual: string; p_note?: string }; Returns: number };
  pos_quote: { Args: { p_kind: string; p_target: string; p_type: string; p_customer?: string }; Returns: Json };
  pos_set_customer_prices: { Args: { p_customer: string; p_rows: Json }; Returns: number };
  pos_complete_sale: { Args: { p_request: string; p_session: string; p_type: string; p_customer: string | null; p_tracking: string | null; p_items: Json; p_payments: Json }; Returns: string };
  pos_record_repayment: { Args: { p_request: string; p_sale: string; p_session: string; p_method: string; p_amount: string }; Returns: string };
};
