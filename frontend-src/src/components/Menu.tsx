import type { ReactNode } from 'react'

export function MenuShell({
  title,
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`rsl-popover ${className}`}>
      {title && (
        <div className="rsl-popover-header px-3 py-2 text-[10px]">
          {title}
        </div>
      )}
      <div className="py-1">
        {children}
      </div>
    </div>
  )
}

export function MenuButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rsl-menu-item w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] ${className}`}
    >
      {children}
    </button>
  )
}
