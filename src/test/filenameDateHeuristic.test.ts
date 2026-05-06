import { describe, it, expect } from 'vitest';
import { evaluateFilenameDate, extractFilenameMonth } from '@/lib/filenameDateHeuristic';

describe('extractFilenameMonth', () => {
  it('parses YYYY-MM', () => {
    expect(extractFilenameMonth('ede_2026-04.csv')).toBe('2026-04');
  });
  it('parses YYYY-MM-DD', () => {
    expect(extractFilenameMonth('ede_2026-04-15.csv')).toBe('2026-04');
  });
  it('parses YYYY_MM', () => {
    expect(extractFilenameMonth('ede_2026_04_export.csv')).toBe('2026-04');
  });
  it('parses MM-YYYY', () => {
    expect(extractFilenameMonth('coverall_04-2026.csv')).toBe('2026-04');
  });
  it('parses compact YYYYMM', () => {
    expect(extractFilenameMonth('bo_202604.csv')).toBe('2026-04');
  });
  it('returns undefined when no date present', () => {
    expect(extractFilenameMonth('random_file.csv')).toBeUndefined();
  });
});

describe('evaluateFilenameDate', () => {
  it('returns none when statementMonth missing', () => {
    expect(evaluateFilenameDate('ede_2026-04.csv', 'EDE', null).kind).toBe('none');
  });

  it('returns none when no date in filename', () => {
    expect(evaluateFilenameDate('random.csv', 'EDE', '2026-04-01').kind).toBe('none');
  });

  it('returns none for matching EDE filename', () => {
    const w = evaluateFilenameDate('ede_2026-04_export.csv', 'EDE', '2026-04-01');
    expect(w.kind).toBe('none');
    expect(w.detectedMonth).toBe('2026-04');
  });

  it('returns HARD warning for EDE month mismatch', () => {
    const w = evaluateFilenameDate('ede_2026-03.csv', 'EDE', '2026-04-01');
    expect(w.kind).toBe('hard');
    expect(w.message).toMatch(/March 2026/);
    expect(w.message).toMatch(/April 2026/);
  });

  it('returns SOFT warning for COMMISSION month mismatch', () => {
    const w = evaluateFilenameDate('coverall_2026-05_statement.csv', 'COMMISSION', '2026-04-01');
    expect(w.kind).toBe('soft');
    expect(w.message).toMatch(/statement issue date/);
  });

  it('returns SOFT warning for BACK_OFFICE month mismatch', () => {
    const w = evaluateFilenameDate('jason_bo_2026-05.csv', 'BACK_OFFICE', '2026-04-01');
    expect(w.kind).toBe('soft');
    expect(w.message).toMatch(/export\/snapshot date/);
  });
});
