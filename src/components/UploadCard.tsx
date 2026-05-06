import { useState, useRef } from 'react';
import { Upload, CheckCircle2, RefreshCw, Loader2, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import type { FilenameWarning } from '@/lib/filenameDateHeuristic';

interface UploadCardProps {
  label: string;
  uploadedFileName?: string | null;
  /** ISO timestamp of the active uploaded_files row (created_at). */
  lastUploadedAt?: string | null;
  /** Active normalized_records count for the active uploaded_file_id. */
  rowCount?: number | null;
  /** Filename-vs-batch-month warning derived from filenameDateHeuristic (#122). */
  warning?: FilenameWarning;
  onUpload: (file: File) => Promise<void>;
  isUploading?: boolean;
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function UploadCard({
  label, uploadedFileName, lastUploadedAt, rowCount, warning, onUpload, isUploading,
}: UploadCardProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    const normalizedName = file.name.toLowerCase();
    const isCsv = normalizedName.endsWith('.csv') || file.type === 'text/csv' || file.type === 'application/vnd.ms-excel';
    if (file && isCsv) await onUpload(file);
  };

  const isEmpty = !isUploading && !uploadedFileName;
  const cardClass = [
    'transition-all',
    dragOver ? 'ring-2 ring-primary border-primary' : '',
    isUploading ? 'ring-2 ring-primary/60 border-primary/60 animate-pulse' : '',
    !isUploading && uploadedFileName ? 'border-success/40 bg-success/5' : '',
    isEmpty ? 'border-dashed border-muted-foreground/30 bg-muted/20' : '',
  ].filter(Boolean).join(' ');

  const showWarning = !isUploading && uploadedFileName && warning && warning.kind !== 'none';
  const isHardWarning = warning?.kind === 'hard';

  return (
    <Card
      className={cardClass}
      onDragOver={(e) => { if (!isUploading) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (isUploading) return;
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      }}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          {isUploading ? (
            <Loader2 className="h-4 w-4 text-primary animate-spin" />
          ) : uploadedFileName ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : null}
        </div>

        {isUploading ? (
          <div className="flex flex-col items-center justify-center py-4 border-2 border-dashed border-primary/40 rounded-lg bg-primary/5">
            <Loader2 className="h-5 w-5 text-primary animate-spin" />
            <span className="text-xs font-medium text-primary mt-1">Processing…</span>
            <span className="text-[10px] text-muted-foreground mt-0.5">Parsing, normalizing, reconciling</span>
          </div>
        ) : uploadedFileName ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="text-xs text-muted-foreground truncate max-w-[160px] cursor-default"
                      data-testid="upload-tile-filename"
                    >
                      {uploadedFileName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs break-all">
                    {uploadedFileName}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <button
                onClick={() => inputRef.current?.click()}
                className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
              >
                <RefreshCw className="h-3 w-3" /> Replace
              </button>
            </div>

            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              {lastUploadedAt ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span data-testid="upload-tile-timestamp" className="cursor-default">
                        Uploaded {formatRelativeTime(lastUploadedAt)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{formatAbsoluteTime(lastUploadedAt)}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : <span />}
              {typeof rowCount === 'number' ? (
                <span data-testid="upload-tile-rowcount" className="font-medium text-foreground/80">
                  {rowCount.toLocaleString()} {rowCount === 1 ? 'row' : 'rows'}
                </span>
              ) : null}
            </div>

            {showWarning && (
              <div
                role="alert"
                data-testid="upload-tile-warning"
                data-warning-kind={warning!.kind}
                className={[
                  'flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug border',
                  isHardWarning
                    ? 'bg-warning/10 border-warning/40 text-warning-foreground'
                    : 'bg-info/10 border-info/40 text-info-foreground',
                ].join(' ')}
              >
                {isHardWarning
                  ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-warning" />
                  : <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-info" />}
                <span>{warning!.message}</span>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center py-4 border-2 border-dashed border-border rounded-lg hover:border-primary/50 transition-colors"
            data-testid="upload-tile-empty"
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground mt-1">No file uploaded</span>
            <span className="text-[10px] text-muted-foreground/70 mt-0.5">Drop CSV or click</span>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          disabled={isUploading}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
      </CardContent>
    </Card>
  );
}
