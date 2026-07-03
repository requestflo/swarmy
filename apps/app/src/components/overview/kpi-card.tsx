import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CountUp } from '@/components/count-up';

interface KpiCardProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  tone: 'online' | 'warning' | 'offline' | 'progress' | 'idle';
}

/** One estate KPI — a doorway card linking into the section it summarizes. */
export function KpiCard({ to, icon, label, value, suffix, tone }: KpiCardProps): React.JSX.Element {
  return (
    <Link to={to} className="card-pop card-pop-hover block p-5">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <span style={{ color: `var(--status-${tone})` }}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mono-data mt-3 text-3xl font-bold">
        <CountUp value={value} />
        {suffix ? <span className="text-muted-foreground text-xl">{suffix}</span> : null}
      </div>
    </Link>
  );
}
