import { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'info';
  onClick?: () => void;
  subtitle?: string;
  tooltip?: string | { text: string; why: string };
}

const variantStyles = {
  default: 'bg-card border-border',
  success: 'bg-success/10 border-success/30',
  warning: 'bg-warning/10 border-warning/30',
  destructive: 'bg-destructive/10 border-destructive/30',
  info: 'bg-info/10 border-info/30',
};

const valueStyles = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-info',
};

export function MetricCard({ title, value, icon, variant = 'default', onClick, subtitle, tooltip }: MetricCardProps) {
  const tooltipContent = tooltip ? (
    typeof tooltip === 'string' ? tooltip : (
      <div className="space-y-1.5">
        <p>{tooltip.text}</p>
        <p className="text-primary/80 font-medium">Why this matters: {tooltip.why}</p>
      </div>
    )
  ) : null;

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`relative rounded-xl border p-5 text-left transition-all hover:shadow-md ${variantStyles[variant]} ${onClick ? 'cursor-pointer hover:scale-[1.02]' : 'cursor-default'}`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
        <div className="flex items-center gap-1.5">
          {tooltip && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <span className="text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[300px] text-xs leading-relaxed">
                  {tooltipContent}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {icon && <span className="text-muted-foreground">{icon}</span>}
        </div>
      </div>
      <div className={`text-3xl font-bold ${valueStyles[variant]}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
    </button>
  );
}
