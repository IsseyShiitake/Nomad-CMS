import type { HTMLAttributes, ReactNode } from 'react';

/** Props for the Card component. */
type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Card content. */
  children: ReactNode;
};

/**
 * Reusable card container.
 *
 * Provides the standard surface, border, radius, and shadow used
 * across the CMS. Optional `className` values are appended so pages
 * can layer feature-specific styles on top.
 */
export function Card({ children, className = '', ...rest }: CardProps) {
  return (
    <div className={`card${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </div>
  );
}