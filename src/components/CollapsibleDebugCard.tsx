import { useState, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsibleDebugCardProps {
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  summary?: ReactNode;
  children: ReactNode;
}

export function CollapsibleDebugCard({
  title,
  icon,
  defaultOpen = false,
  summary,
  children,
}: CollapsibleDebugCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="border-dashed">
      <CardHeader className="py-2 px-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          <div className="flex items-center gap-3 min-w-0">
            {summary && !open && (
              <div className="text-xs text-muted-foreground truncate hidden sm:block">{summary}</div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
              {open ? 'Hide' : 'Show'}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && <CardContent className="px-4 pb-3 pt-0 space-y-2">{children}</CardContent>}
    </Card>
  );
}
