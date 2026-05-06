import { useRef } from 'react';
import { AlertTriangle, FileText, Calendar, Tag } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { FilenameWarning } from '@/lib/filenameDateHeuristic';

export interface WrongBatchConfirmModalProps {
  open: boolean;
  /** Destination batch label, e.g. "April 2026 — Ambetter". */
  batchLabel: string | null;
  /** Slot / file_label, e.g. "EDE Archived Not Enrolled". */
  fileLabel: string | null;
  /** Selected file. */
  file: File | null;
  /** Filename-vs-batch warning descriptor (always provided, may be 'none'). */
  warning: FilenameWarning;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Pre-upload confirmation modal (#122). Surfaces the destination batch, slot,
 * file name, and file size, and blocks the upload until the operator either
 * confirms or cancels. Outside-click cannot dismiss (Radix AlertDialog
 * default); Escape cancels.
 *
 * Filename-vs-batch heuristic shows a non-blocking warning when the filename
 * date appears to disagree with the destination batch. Hard warning for EDE
 * files; softer warning for Commission/Back Office.
 */
export function WrongBatchConfirmModal({
  open, batchLabel, fileLabel, file, warning, onConfirm, onCancel,
}: WrongBatchConfirmModalProps) {
  const isHard = warning.kind === 'hard';
  const isSoft = warning.kind === 'soft';
  // Radix fires onOpenChange(false) for both Cancel and Confirm clicks
  // (and for Escape, which we already intercept). Without a guard, Confirm
  // would also count as a Cancel and Cancel would be called twice. Track
  // whether the close was driven by an explicit Confirm/Cancel click so the
  // Radix-driven close becomes a no-op in that case.
  const handledRef = useRef(false);

  const handleConfirm = () => {
    handledRef.current = true;
    onConfirm();
  };
  const handleCancel = () => {
    handledRef.current = true;
    onCancel();
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) { handledRef.current = false; return; }
        if (handledRef.current) { handledRef.current = false; return; }
        onCancel();
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(e) => { e.preventDefault(); handleCancel(); }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm upload destination</AlertDialogTitle>
          <AlertDialogDescription>
            Verify the destination batch and slot before this file is uploaded.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Destination batch</div>
                <div className="font-semibold text-foreground">{batchLabel ?? '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Tag className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Slot</div>
                <div className="font-semibold text-foreground">{fileLabel ?? '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">File</div>
                <div className="font-mono text-foreground break-all">{file?.name ?? '—'}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{file ? formatBytes(file.size) : ''}</div>
              </div>
            </div>
          </div>

          {warning.message && (
            <div
              role="alert"
              className={
                isHard
                  ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 flex items-start gap-2'
                  : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-start gap-2'
              }
            >
              <AlertTriangle
                className={isHard ? 'h-4 w-4 mt-0.5 text-destructive shrink-0' : 'h-4 w-4 mt-0.5 text-amber-600 shrink-0'}
              />
              <div className={isHard ? 'text-destructive text-sm' : 'text-amber-700 dark:text-amber-400 text-sm'}>
                {warning.message}
              </div>
            </div>
          )}

          {!warning.message && isSoft === false && isHard === false && (
            <div className="text-xs text-muted-foreground">
              Press <span className="font-mono">Esc</span> to cancel, or click Confirm Upload to proceed.
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} autoFocus>
            Confirm Upload
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
