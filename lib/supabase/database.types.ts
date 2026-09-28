import type { PosTables, PosFunctions } from "@/lib/pos/types";

export type PosProfile = {
  id: string;
  full_name: string;
  role: "admin" | "cashier";
  active: boolean;
  created_at: string;
  updated_at: string;
};

// Only the table owned by this application is described here.
export type Database = {
  public: {
    Tables: PosTables & {
      pos_profiles: {
        Row: PosProfile;
        Insert: Pick<PosProfile, "id" | "full_name" | "role"> & Partial<Pick<PosProfile, "active" | "created_at" | "updated_at">>;
        Update: Partial<Omit<PosProfile, "id">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: PosFunctions;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
