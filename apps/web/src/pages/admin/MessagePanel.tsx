import type { Message } from './shared.ts'

/** Emerald "ok" / rose "error" inline panel, shared by every admin action. */
export function MessagePanel(
  { message, className = '' }: { message: Message; className?: string },
) {
  return (
    <div
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-3 text-sm ${
        message.tone === 'ok'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800'
      } ${className}`}
    >
      {message.text}
    </div>
  )
}
