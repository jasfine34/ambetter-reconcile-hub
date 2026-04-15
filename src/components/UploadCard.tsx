import { useState, useRef } from 'react';
import { Upload, CheckCircle2, RefreshCw } from 'lucide-react';
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

  return (
    <Card
      className={`transition-all ${dragOver ? 'ring-2 ring-primary border-primary' : ''} ${uploadedFileName ? 'border-success/40 bg-success/5' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          {uploadedFileName && <CheckCircle2 className="h-4 w-4 text-success" />}
        </div>
        {uploadedFileName ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground truncate max-w-[140px]">{uploadedFileName}</span>
            <button
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <RefreshCw className="h-3 w-3" /> Replace
            </button>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={isUploading}
            className="w-full flex flex-col items-center justify-center py-4 border-2 border-dashed border-border rounded-lg hover:border-primary/50 transition-colors"
          >
            {isUploading ? (
              <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground mt-1">
              {isUploading ? 'Processing...' : 'Drop CSV or click'}
            </span>
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
      </CardContent>
    </Card>
  );
}
