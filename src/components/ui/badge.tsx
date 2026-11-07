import * as React from 'react';
import { cn } from '../../lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | 'success';
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return <div className={cn('ui-badge', `ui-badge-${variant}`, className)} {...props} />;
}
