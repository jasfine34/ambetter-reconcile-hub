import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Upload, AlertTriangle, Users, Building2, Link2, FileText, CalendarRange, FileDown } from 'lucide-react';

const links = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/upload', icon: Upload, label: 'Upload' },
  { to: '/exceptions', icon: AlertTriangle, label: 'Exceptions' },
  { to: '/agents', icon: Users, label: 'Agent Summary' },
  { to: '/entities', icon: Building2, label: 'Entity Summary' },
  { to: '/manual-match', icon: Link2, label: 'Manual Match' },
  { to: '/member-timeline', icon: CalendarRange, label: 'Member Timeline' },
  { to: '/records', icon: FileText, label: 'All Records' },
  { to: '/exports/missing-commission', icon: FileDown, label: 'Missing Commission' },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex">
      <aside className="w-60 border-r border-border bg-card flex flex-col shrink-0">
        <div className="p-5 border-b border-border">
          <h1 className="text-base font-bold text-foreground tracking-tight">Coverall</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">Commission Reconciliation</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {links.map(link => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`
              }
            >
              <link.icon className="h-4 w-4" />
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-border text-[10px] text-muted-foreground">
          Coverall Health Group
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
