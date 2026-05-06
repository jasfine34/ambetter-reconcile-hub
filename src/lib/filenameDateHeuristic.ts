/**
 * Filename-vs-batch date heuristic for Wrong-Batch Upload Confirmation Modal.
 *
 * Looks at the selected file's filename for an embedded YYYY-MM (or YYYY-MM-DD,
 * or YYYY_MM, or YYYYMM) date and compares it to the destination batch's
 * statement_month. Severity depends on source type because filename dates mean
 * different things for different file kinds:
 *
 *   - EDE: filename date almost always corresponds to the coverage/service
 *     month, so a mismatch is a strong signal the operator is uploading into
 *     the wrong batch. We surface a HARD warning.
 *   - COMMISSION: filename date is typically the statement issue date, not the
 *     service month, so a mismatch is expected. SOFT warning only.
 *   - BACK_OFFICE: filename date is typically the export/snapshot date, also
 *     not the service month. SOFT warning only.
 *
 * Never blocking — operators can always confirm.
 */

export type FilenameWarningKind = 'none' | 'soft' | 'hard';

export interface FilenameWarning {
  kind: FilenameWarningKind;
  message?: string;
  /** YYYY-MM extracted from the filename, if any. Useful for tests. */
  detectedMonth?: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const idx = Number(m) - 1;
  if (idx < 0 || idx > 11) return yyyymm;
  return `${MONTH_NAMES[idx]} ${y}`;
}

/**
 * Extract a YYYY-MM from a filename. Supports common patterns:
 *   2026-04, 2026_04, 202604, 2026-04-15, 04-2026, 04_2026
 */
export function extractFilenameMonth(fileName: string): string | undefined {
  if (!fileName) return undefined;

  // YYYY-MM or YYYY-MM-DD or YYYY_MM
  const isoMatch = fileName.match(/(20\d{2})[-_](0[1-9]|1[0-2])(?:[-_](\d{1,2}))?/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;

  // MM-YYYY or MM_YYYY
  const usMatch = fileName.match(/(?<!\d)(0[1-9]|1[0-2])[-_](20\d{2})(?!\d)/);
  if (usMatch) return `${usMatch[2]}-${usMatch[1]}`;

  // YYYYMM (compact, exactly 6 digits surrounded by non-digits)
  const compactMatch = fileName.match(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(?!\d)/);
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}`;

  return undefined;
}

/**
 * Compare a filename's embedded date (if any) to the destination batch
 * statement month and return a warning descriptor.
 *
 * @param fileName        The selected file's name.
 * @param sourceType      'EDE' | 'BACK_OFFICE' | 'COMMISSION'
 * @param statementMonth  Batch statement_month (YYYY-MM-DD or YYYY-MM).
 */
export function evaluateFilenameDate(
  fileName: string,
  sourceType: string,
  statementMonth: string | null | undefined,
): FilenameWarning {
  if (!statementMonth) return { kind: 'none' };
  const detectedMonth = extractFilenameMonth(fileName);
  if (!detectedMonth) return { kind: 'none' };

  const batchMonth = String(statementMonth).substring(0, 7);
  if (detectedMonth === batchMonth) return { kind: 'none', detectedMonth };

  const detectedLabel = formatMonth(detectedMonth);
  const batchLabel = formatMonth(batchMonth);

  if (sourceType === 'EDE') {
    return {
      kind: 'hard',
      detectedMonth,
      message: `Filename appears to be for ${detectedLabel}, but destination batch is ${batchLabel}. Verify before uploading.`,
    };
  }

  if (sourceType === 'COMMISSION') {
    return {
      kind: 'soft',
      detectedMonth,
      message: `Filename suggests ${detectedLabel}, but destination batch is ${batchLabel}. For commission statements the filename date is often the statement issue date, not the service month — verify if unsure.`,
    };
  }

  // BACK_OFFICE and anything else
  return {
    kind: 'soft',
    detectedMonth,
    message: `Filename suggests ${detectedLabel}, but destination batch is ${batchLabel}. For Back Office files the filename date is often the export/snapshot date — verify if unsure.`,
  };
}
