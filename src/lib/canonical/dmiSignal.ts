/**
 * Phase C1a — DMI signal accessor.
 *
 * PURE. Raw accessor only — source selection (which EDE record, which
 * service month) happens in the facts layer.
 *
 * Reads three raw_json fields off a single EDE-shaped record:
 *   - verificationIssueType        (e.g. DMI_CITIZENSHIP, DMI_ANNUAL_INCOME,
 *                                   DMI_QHP_LAWFUL_PRESENCE, DMI_NONESCMEC)
 *   - verificationEndDate          (date string; tolerant of blank/missing)
 *   - documentUploadedForSviDmi    ('Y' / 'N' / blank)
 *
 * Returns null when the input is missing OR the issueType is blank — so the
 * facts layer can short-circuit on (signal === null) === "no active DMI on
 * this record".
 */
export interface DmiSignal {
  issueType: string;
  /** Normalized to 'YYYY-MM-DD' when parseable; null otherwise. */
  verificationEndDate: string | null;
  /** True iff raw flag === 'Y' (case-insensitive). */
  documentUploaded: boolean;
}

export interface DmiSignalSource {
  raw_json?: Record<string, unknown> | null;
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeDate(v: unknown): string | null {
  const s = trimStr(v);
  if (!s) return null;
  // Accept YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss... — take the leading 10.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function getDmiSignal(record: DmiSignalSource | null | undefined): DmiSignal | null {
  if (!record) return null;
  const raw = (record.raw_json ?? null) as Record<string, unknown> | null;
  if (!raw) return null;
  const issueType = trimStr(raw['verificationIssueType']);
  if (!issueType) return null;
  return {
    issueType,
    verificationEndDate: normalizeDate(raw['verificationEndDate']),
    documentUploaded: trimStr(raw['documentUploadedForSviDmi']).toUpperCase() === 'Y',
  };
}

/** Helper: is the verificationEndDate strictly before `today` (YYYY-MM-DD)? */
export function isDmiExpired(
  signal: DmiSignal | null,
  today: string,
): boolean {
  if (!signal || !signal.verificationEndDate) return false;
  return signal.verificationEndDate < today;
}
