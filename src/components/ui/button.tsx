import * as React from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'minimal';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'minimal', size = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className)}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
