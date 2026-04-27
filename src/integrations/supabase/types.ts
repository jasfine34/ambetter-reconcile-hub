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
      agent_appointments: {
        Row: {
          agent_name: string | null
          agent_npn: string
          carrier_normalized: string | null
          carrier_raw: string | null
          id: string
          ingested_at: string
          is_coverall_aor: boolean
          last_activity_date: string | null
          state: string | null
          status: string | null
          writing_number: string | null
        }
        Insert: {
          agent_name?: string | null
          agent_npn: string
          carrier_normalized?: string | null
          carrier_raw?: string | null
          id?: string
          ingested_at?: string
          is_coverall_aor?: boolean
          last_activity_date?: string | null
          state?: string | null
          status?: string | null
          writing_number?: string | null
        }
        Update: {
          agent_name?: string | null
          agent_npn?: string
          carrier_normalized?: string | null
          carrier_raw?: string | null
          id?: string
          ingested_at?: string
          is_coverall_aor?: boolean
          last_activity_date?: string | null
          state?: string | null
          status?: string | null
          writing_number?: string | null
        }
        Relationships: []
      }
      bo_snapshots: {
        Row: {
          agent_bucket: string | null
          carrier: string
          created_at: string
          id: string
          snapshot_date: string
          uploaded_file_id: string | null
        }
        Insert: {
          agent_bucket?: string | null
          carrier?: string
          created_at?: string
          id?: string
          snapshot_date?: string
          uploaded_file_id?: string | null
        }
        Update: {
          agent_bucket?: string | null
          carrier?: string
          created_at?: string
          id?: string
          snapshot_date?: string
          uploaded_file_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bo_snapshots_uploaded_file_id_fkey"
            columns: ["uploaded_file_id"]
            isOneToOne: false
            referencedRelation: "uploaded_files"
            referencedColumns: ["id"]
          },
        ]
      }
      carriers: {
        Row: {
          aliases: string[]
          canonical_key: string
          created_at: string
          display_name: string
        }
        Insert: {
          aliases?: string[]
          canonical_key: string
          created_at?: string
          display_name: string
        }
        Update: {
          aliases?: string[]
          canonical_key?: string
          created_at?: string
          display_name?: string
        }
        Relationships: []
      }
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
      ede_snapshots: {
        Row: {
          created_at: string
          id: string
          snapshot_date: string
          source_kind: string | null
          uploaded_file_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          snapshot_date?: string
          source_kind?: string | null
          uploaded_file_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          snapshot_date?: string
          source_kind?: string | null
          uploaded_file_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ede_snapshots_uploaded_file_id_fkey"
            columns: ["uploaded_file_id"]
            isOneToOne: false
            referencedRelation: "uploaded_files"
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
          auto_renewal: boolean | null
          batch_id: string
          bo_snapshot_id: string | null
          broker_effective_date: string | null
          broker_term_date: string | null
          carrier: string | null
          client_address_1: string | null
          client_address_2: string | null
          client_city: string | null
          client_state_full: string | null
          client_zip: string | null
          commission_amount: number | null
          created_at: string
          dob: string | null
          ede_bucket: string | null
          ede_policy_origin_type: string | null
          ede_snapshot_id: string | null
          effective_date: string | null
          eligible_for_commission: string | null
          exchange_policy_id: string | null
          exchange_subscriber_id: string | null
          first_name: string | null
          id: string
          issuer_policy_id: string | null
          issuer_subscriber_id: string | null
          last_name: string | null
          member_id: string | null
          member_key: string | null
          member_responsibility: number | null
          months_paid: number | null
          net_premium: number | null
          on_off_exchange: string | null
          paid_through_date: string | null
          paid_to_date: string | null
          pay_entity: string | null
          policy_modified_date: string | null
          policy_number: string | null
          policy_term_date: string | null
          premium: number | null
          raw_json: Json | null
          source_file_label: string
          source_type: string
          status: string | null
          superseded_at: string | null
          uploaded_file_id: string
          writing_agent_carrier_id: string | null
        }
        Insert: {
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          auto_renewal?: boolean | null
          batch_id: string
          bo_snapshot_id?: string | null
          broker_effective_date?: string | null
          broker_term_date?: string | null
          carrier?: string | null
          client_address_1?: string | null
          client_address_2?: string | null
          client_city?: string | null
          client_state_full?: string | null
          client_zip?: string | null
          commission_amount?: number | null
          created_at?: string
          dob?: string | null
          ede_bucket?: string | null
          ede_policy_origin_type?: string | null
          ede_snapshot_id?: string | null
          effective_date?: string | null
          eligible_for_commission?: string | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          first_name?: string | null
          id?: string
          issuer_policy_id?: string | null
          issuer_subscriber_id?: string | null
          last_name?: string | null
          member_id?: string | null
          member_key?: string | null
          member_responsibility?: number | null
          months_paid?: number | null
          net_premium?: number | null
          on_off_exchange?: string | null
          paid_through_date?: string | null
          paid_to_date?: string | null
          pay_entity?: string | null
          policy_modified_date?: string | null
          policy_number?: string | null
          policy_term_date?: string | null
          premium?: number | null
          raw_json?: Json | null
          source_file_label: string
          source_type: string
          status?: string | null
          superseded_at?: string | null
          uploaded_file_id: string
          writing_agent_carrier_id?: string | null
        }
        Update: {
          agent_name?: string | null
          agent_npn?: string | null
          aor_bucket?: string | null
          applicant_name?: string | null
          auto_renewal?: boolean | null
          batch_id?: string
          bo_snapshot_id?: string | null
          broker_effective_date?: string | null
          broker_term_date?: string | null
          carrier?: string | null
          client_address_1?: string | null
          client_address_2?: string | null
          client_city?: string | null
          client_state_full?: string | null
          client_zip?: string | null
          commission_amount?: number | null
          created_at?: string
          dob?: string | null
          ede_bucket?: string | null
          ede_policy_origin_type?: string | null
          ede_snapshot_id?: string | null
          effective_date?: string | null
          eligible_for_commission?: string | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          first_name?: string | null
          id?: string
          issuer_policy_id?: string | null
          issuer_subscriber_id?: string | null
          last_name?: string | null
          member_id?: string | null
          member_key?: string | null
          member_responsibility?: number | null
          months_paid?: number | null
          net_premium?: number | null
          on_off_exchange?: string | null
          paid_through_date?: string | null
          paid_to_date?: string | null
          pay_entity?: string | null
          policy_modified_date?: string | null
          policy_number?: string | null
          policy_term_date?: string | null
          premium?: number | null
          raw_json?: Json | null
          source_file_label?: string
          source_type?: string
          status?: string | null
          superseded_at?: string | null
          uploaded_file_id?: string
          writing_agent_carrier_id?: string | null
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
            foreignKeyName: "normalized_records_bo_snapshot_id_fkey"
            columns: ["bo_snapshot_id"]
            isOneToOne: false
            referencedRelation: "bo_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_records_ede_snapshot_id_fkey"
            columns: ["ede_snapshot_id"]
            isOneToOne: false
            referencedRelation: "ede_snapshots"
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
          clawback_amount: number | null
          created_at: string
          dob: string | null
          eligible_for_commission: string | null
          estimated_missing_commission: number | null
          exchange_policy_id: string | null
          exchange_subscriber_id: string | null
          expected_ede_effective_month: string | null
          expected_pay_entity: string | null
          id: string
          in_back_office: boolean
          in_commission: boolean
          in_ede: boolean
          is_in_expected_ede_universe: boolean
          issue_notes: string | null
          issue_type: string | null
          issuer_policy_id: string | null
          issuer_subscriber_id: string | null
          member_key: string
          net_premium: number | null
          policy_number: string | null
          positive_commission: number | null
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
          clawback_amount?: number | null
          created_at?: string
          dob?: string | null
          eligible_for_commission?: string | null
          estimated_missing_commission?: number | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          expected_ede_effective_month?: string | null
          expected_pay_entity?: string | null
          id?: string
          in_back_office?: boolean
          in_commission?: boolean
          in_ede?: boolean
          is_in_expected_ede_universe?: boolean
          issue_notes?: string | null
          issue_type?: string | null
          issuer_policy_id?: string | null
          issuer_subscriber_id?: string | null
          member_key: string
          net_premium?: number | null
          policy_number?: string | null
          positive_commission?: number | null
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
          clawback_amount?: number | null
          created_at?: string
          dob?: string | null
          eligible_for_commission?: string | null
          estimated_missing_commission?: number | null
          exchange_policy_id?: string | null
          exchange_subscriber_id?: string | null
          expected_ede_effective_month?: string | null
          expected_pay_entity?: string | null
          id?: string
          in_back_office?: boolean
          in_commission?: boolean
          in_ede?: boolean
          is_in_expected_ede_universe?: boolean
          issue_notes?: string | null
          issue_type?: string | null
          issuer_policy_id?: string | null
          issuer_subscriber_id?: string | null
          member_key?: string
          net_premium?: number | null
          policy_number?: string | null
          positive_commission?: number | null
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
      resolved_identities: {
        Row: {
          conflict_count: number
          conflict_details: Json | null
          id: string
          match_key_type: string
          match_key_value: string
          resolved_at: string
          resolved_exchange_policy_id: string | null
          resolved_issuer_policy_id: string | null
          resolved_issuer_subscriber_id: string | null
          reviewed_at: string | null
          source_batch_id: string | null
          source_file_id: string | null
          source_kind: string | null
        }
        Insert: {
          conflict_count?: number
          conflict_details?: Json | null
          id?: string
          match_key_type: string
          match_key_value: string
          resolved_at?: string
          resolved_exchange_policy_id?: string | null
          resolved_issuer_policy_id?: string | null
          resolved_issuer_subscriber_id?: string | null
          reviewed_at?: string | null
          source_batch_id?: string | null
          source_file_id?: string | null
          source_kind?: string | null
        }
        Update: {
          conflict_count?: number
          conflict_details?: Json | null
          id?: string
          match_key_type?: string
          match_key_value?: string
          resolved_at?: string
          resolved_exchange_policy_id?: string | null
          resolved_issuer_policy_id?: string | null
          resolved_issuer_subscriber_id?: string | null
          reviewed_at?: string | null
          source_batch_id?: string | null
          source_file_id?: string | null
          source_kind?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resolved_identities_source_batch_id_fkey"
            columns: ["source_batch_id"]
            isOneToOne: false
            referencedRelation: "upload_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resolved_identities_source_file_id_fkey"
            columns: ["source_file_id"]
            isOneToOne: false
            referencedRelation: "uploaded_files"
            referencedColumns: ["id"]
          },
        ]
      }
      upload_batches: {
        Row: {
          carrier: string
          created_at: string
          id: string
          last_full_rebuild_at: string | null
          last_rebuild_logic_version: string | null
          notes: string | null
          statement_month: string | null
        }
        Insert: {
          carrier?: string
          created_at?: string
          id?: string
          last_full_rebuild_at?: string | null
          last_rebuild_logic_version?: string | null
          notes?: string | null
          statement_month?: string | null
        }
        Update: {
          carrier?: string
          created_at?: string
          id?: string
          last_full_rebuild_at?: string | null
          last_rebuild_logic_version?: string | null
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
          snapshot_date: string | null
          source_type: string
          storage_path: string | null
          superseded_at: string | null
        }
        Insert: {
          aor_bucket?: string | null
          batch_id: string
          created_at?: string
          file_label: string
          file_name: string
          id?: string
          pay_entity?: string | null
          snapshot_date?: string | null
          source_type: string
          storage_path?: string | null
          superseded_at?: string | null
        }
        Update: {
          aor_bucket?: string | null
          batch_id?: string
          created_at?: string
          file_label?: string
          file_name?: string
          id?: string
          pay_entity?: string | null
          snapshot_date?: string | null
          source_type?: string
          storage_path?: string | null
          superseded_at?: string | null
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
      weak_match_overrides: {
        Row: {
          candidate_bo_member_key: string | null
          candidate_bo_stable_key: string | null
          created_at: string
          decided_at: string
          decided_by: string | null
          decision: string
          id: string
          notes: string | null
          override_key: string
          signals: Json | null
        }
        Insert: {
          candidate_bo_member_key?: string | null
          candidate_bo_stable_key?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string | null
          decision: string
          id?: string
          notes?: string | null
          override_key: string
          signals?: Json | null
        }
        Update: {
          candidate_bo_member_key?: string | null
          candidate_bo_stable_key?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string | null
          decision?: string
          id?: string
          notes?: string | null
          override_key?: string
          signals?: Json | null
        }
        Relationships: []
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
