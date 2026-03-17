import type { ReactNode } from 'react'

type DialogTone = 'brand' | 'info' | 'success' | 'danger' | 'neutral'

const DIALOG_TONES: Record<DialogTone, { headerBg: string; title: string }> = {
  brand: {
    headerBg: '#1e1a20',
    title: '#c0392b',
  },
  info: {
    headerBg: '#1e1a20',
    title: '#6bc5e8',
  },
  success: {
    headerBg: '#0f1a18',
    title: '#3abfa0',
  },
  danger: {
    headerBg: '#3a1520',
    title: '#c0392b',
  },
  neutral: {
    headerBg: '#1e1a20',
    title: '#e7dfd3',
  },
}

interface DialogShellProps {
  title: string
  subtitle?: string
  tone?: DialogTone
  onClose?: () => void
  widthClassName?: string
  panelClassName?: string
  bodyClassName?: string
  footer?: ReactNode
  children: ReactNode
}

export function DialogShell({
  title,
  subtitle,
  tone = 'info',
  onClose,
  widthClassName = 'max-w-[520px]',
  panelClassName = '',
  bodyClassName = 'px-5 py-4',
  footer,
  children,
}: DialogShellProps) {
  const palette = DIALOG_TONES[tone]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.78)] px-4 py-6 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full border-[3px] border-black bg-[#141018] ${widthClassName} ${panelClassName}`}
        style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.02) inset' }}
      >
        <div
          className="border-b-[3px] border-black px-5 py-3 flex items-start justify-between gap-4"
          style={{ background: palette.headerBg }}
        >
          <div className="min-w-0">
            <div className="text-[13px] uppercase tracking-[0.08em]" style={{ color: palette.title }}>
              {title}
            </div>
            {subtitle && (
              <div className="text-[11px] text-[#4a4048] mt-1">
                {subtitle}
              </div>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none shrink-0"
            >
              ×
            </button>
          )}
        </div>
        <div className={bodyClassName}>{children}</div>
        {footer && (
          <div className="border-t-[3px] border-black">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
