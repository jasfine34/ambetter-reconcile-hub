export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      commission_estimates: {
        Row: {
          basis: string | null
          batch_id: string
          created_at: string
          estimated_commission: number
          id: string
          member_key: string
        }
        Insert: {
          basis?: string | null
          batch_id: string
          created_at?: string
          estimated_commission: number
          id?: string
          member_key: string
        }
        Update: {
          basis?: string | null
          batch_id?: string
          created_at?: string
          estimated_commission?: number
          id?: string
          member_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "commission_estimates_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "upload_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_match_overrides: {
        Row: {
          carrier: string
          created_at: string
          id: string
          left_source_record_id: string | null
          override_reason: string | null
          right_source_record_id: string | null
        }
        Insert: {
          carrier?: string
          created_at?: string
          id?: string
          left_source_record_id?: string | null
          override_reason?: string | null
          right_source_record_id?: string | null
        }
        Update: {
          carrier?: string
          created_at?: string
          id?: string
          left_source_record_id?: string | null
          override_reason?: string | null
          right_source_record_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "manual_match_overrides_left_source_record_id_fkey"
            columns: ["left_source_record_id"]
            isOneToOne: false
            referencedRelation: "normalized_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manual_match_overrides_right_source_record_id_fkey"
            columns: ["right_source_record_id"]
            isOneToOne: false
            referencedRelation: "normalized_records"
            referencedColumns: ["id"]
          },
        ]
      }
      normalized_records: {
        Row: {
          agent_name: string | null
          agent_npn: string | null
          aor_bucket: string | null
          applicant_name: string | null
          batch_id: string
          carrier: string | null
          commission_amount: number | null
          created_at: string
          dob: string | null
          effective_date: string | null
          eligible_for_commission: string | null
          exchange_policy_id: string | null
          exchange_subscriber_id: string | null
          first_name: string | null
          id: string
          issuer_policy_id: string | null
          last_name: string | null
          member_id: string | null
          member_key: string | null
          net_premium: number | null
          pay_entity: string | null
          policy_number: string | null
          premium: number | null
          raw_json: Json | null
          source_file_label: string
          source_type: string
          status: string | null
          uploaded_file_id: string
        }
        Insert: {
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          batch_id: string
          carrier?: string | null
          commission_amount?: number | null
          created_at?: string
          dob?: string | null
          effective_date?: string | null
          eligible_for_commission?: string | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          first_name?: string | null
          id?: string
          issuer_policy_id?: string | null
          last_name?: string | null
          member_id?: string | null
          member_key?: string | null
          net_premium?: number | null
          pay_entity?: string | null
          policy_number?: string | null
          premium?: number | null
          raw_json?: Json | null
          source_file_label: string
          source_type: string
          status?: string | null
          uploaded_file_id: string
        }
        Update: {
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          batch_id?: string
          carrier?: string | null
          commission_amount?: number | null
          created_at?: string
          dob?: string | null
          effective_date?: string | null
          eligible_for_commission?: string | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          first_name?: string | null
          id?: string
          issuer_policy_id?: string | null
          last_name?: string | null
          member_id?: string | null
          member_key?: string | null
          net_premium?: number | null
          pay_entity?: string | null
          policy_number?: string | null
          premium?: number | null
          raw_json?: Json | null
          source_file_label?: string
          source_type?: string
          status?: string | null
          uploaded_file_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_records_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "upload_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_records_uploaded_file_id_fkey"
            columns: ["uploaded_file_id"]
            isOneToOne: false
            referencedRelation: "uploaded_files"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciled_members: {
        Row: {
          actual_commission: number | null
          actual_pay_entity: string | null
          agent_name: string | null
          agent_npn: string | null
          aor_bucket: string | null
          applicant_name: string | null
          batch_id: string
          carrier: string | null
          created_at: string
          dob: string | null
          eligible_for_commission: string | null
          estimated_missing_commission: number | null
          exchange_policy_id: string | null
          exchange_subscriber_id: string | null
          expected_pay_entity: string | null
          id: string
          in_back_office: boolean
          in_commission: boolean
          in_ede: boolean
          issue_notes: string | null
          issue_type: string | null
          issuer_policy_id: string | null
          member_key: string
          net_premium: number | null
          policy_number: string | null
          premium: number | null
        }
        Insert: {
          actual_commission?: number | null
          actual_pay_entity?: string | null
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          batch_id: string
          carrier?: string | null
          created_at?: string
          dob?: string | null
          eligible_for_commission?: string | null
          estimated_missing_commission?: number | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          expected_pay_entity?: string | null
          id?: string
          in_back_office?: boolean
          in_commission?: boolean
          in_ede?: boolean
          issue_notes?: string | null
          issue_type?: string | null
          issuer_policy_id?: string | null
          member_key: string
          net_premium?: number | null
          policy_number?: string | null
          premium?: number | null
        }
        Update: {
          actual_commission?: number | null
          actual_pay_entity?: string | null
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          batch_id?: string
          carrier?: string | null
          created_at?: string
          dob?: string | null
          eligible_for_commission?: string | null
          estimated_missing_commission?: number | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          expected_pay_entity?: string | null
          id?: string
          in_back_office?: boolean
          in_commission?: boolean
          in_ede?: boolean
          issue_notes?: string | null
          issue_type?: string | null
          issuer_policy_id?: string | null
          member_key?: string
          net_premium?: number | null
          policy_number?: string | null
          premium?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciled_members_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "upload_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      upload_batches: {
        Row: {
          carrier: string
          created_at: string
          id: string
          notes: string | null
          statement_month: string | null
        }
        Insert: {
          carrier?: string
          created_at?: string
          id?: string
          notes?: string | null
          statement_month?: string | null
        }
        Update: {
          carrier?: string
          created_at?: string
          id?: string
          notes?: string | null
          statement_month?: string | null
        }
        Relationships: []
      }
      uploaded_files: {
        Row: {
          aor_bucket: string | null
          batch_id: string
          created_at: string
          file_label: string
          file_name: string
          id: string
          pay_entity: string | null
          source_type: string
          storage_path: string | null
        }
        Insert: {
          aor_bucket?: string | null
          batch_id: string
          created_at?: string
          file_label: string
          file_name: string
          id?: string
          pay_entity?: string | null
          source_type: string
          storage_path?: string | null
        }
        Update: {
          aor_bucket?: string | null
          batch_id?: string
          created_at?: string
          file_label?: string
          file_name?: string
          id?: string
          pay_entity?: string | null
          source_type?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "uploaded_files_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "upload_batches"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
