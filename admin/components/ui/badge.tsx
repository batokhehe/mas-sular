import { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type BadgeTone = 'success' | 'danger' | 'neutral' | 'brand';

const tones: Record<BadgeTone, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
  brand: 'bg-indigo-50 text-[#465fff]',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium', tones[tone], className)}
      {...props}
    />
  );
}
