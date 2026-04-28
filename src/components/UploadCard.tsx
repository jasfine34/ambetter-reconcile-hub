import { useState, useRef } from 'react';
import { Upload, CheckCircle2, RefreshCw, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface UploadCardProps {
  label: string;
  uploadedFileName?: string | null;
  onUpload: (file: File) => Promise<void>;
  isUploading?: boolean;
}

export function UploadCard({ label, uploadedFileName, onUpload, isUploading }: UploadCardProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    const normalizedName = file.name.toLowerCase();
    const isCsv = normalizedName.endsWith('.csv') || file.type === 'text/csv' || file.type === 'application/vnd.ms-excel';

    if (file && isCsv) {
      await onUpload(file);
    }
  };

  // Card-level styling: highlight dragover, mark as uploaded, pulse during
  // processing. Empty slots get a dashed muted border so they are visually
  // distinct from the green "filled" state (FINDING #62 — masking #68).
  const isEmpty = !isUploading && !uploadedFileName;
  const cardClass = [
    'transition-all',
    dragOver ? 'ring-2 ring-primary border-primary' : '',
    isUploading ? 'ring-2 ring-primary/60 border-primary/60 animate-pulse' : '',
    !isUploading && uploadedFileName ? 'border-success/40 bg-success/5' : '',
    isEmpty ? 'border-dashed border-muted-foreground/30 bg-muted/20' : '',
  ].filter(Boolean).join(' ');

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
          // Dedicated processing state — same layout whether this is a fresh
          // upload or a replacement, so the user always sees clear feedback.
          <div className="flex flex-col items-center justify-center py-4 border-2 border-dashed border-primary/40 rounded-lg bg-primary/5">
            <Loader2 className="h-5 w-5 text-primary animate-spin" />
            <span className="text-xs font-medium text-primary mt-1">Processing…</span>
            <span className="text-[10px] text-muted-foreground mt-0.5">Parsing, normalizing, reconciling</span>
          </div>
        ) : uploadedFileName ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground truncate max-w-[140px]">{uploadedFileName}</span>
            <button
              onClick={() => inputRef.current?.click()}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <RefreshCw className="h-3 w-3" /> Replace
            </button>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center py-4 border-2 border-dashed border-border rounded-lg hover:border-primary/50 transition-colors"
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground mt-1">Drop CSV or click</span>
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
