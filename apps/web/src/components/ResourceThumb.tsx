import { useState } from 'react'
import type { ResourceType } from '@research-portal/core'
import { thumbnailUrl } from '../api/client.ts'
import { hueFromId } from './ui.tsx'

const TYPE_GLYPHS: Record<string, string> = {
  document: 'M7 3h7l5 5v13H7zM14 3v5h5',
  pdf: 'M7 3h7l5 5v13H7zM14 3v5h5M9.5 13h5M9.5 16h5',
  web:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM3.6 9h16.8M3.6 15h16.8M12 3c-2.5 2.4-3.8 5.4-3.8 9s1.3 6.6 3.8 9c2.5-2.4 3.8-5.4 3.8-9s-1.3-6.6-3.8-9z',
  video: 'M4 5h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2zM18 10l4-2.5v9L18 14',
  audio:
    'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  image:
    'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5-9 9',
}

/**
 * Resource artwork used everywhere resources appear: the platform thumbnail
 * when one exists, otherwise a colour-blocked panel with a type glyph.
 */
export function ResourceThumb({
  slug,
  id,
  type,
  className = '',
}: {
  slug: string
  id: string
  type: ResourceType | string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const glyph = TYPE_GLYPHS[type] ?? TYPE_GLYPHS.document
  return (
    <div
      aria-hidden='true'
      className={`relative h-full w-full ${className}`}
      style={{ background: 'hsl(' + hueFromId(id) + ', 32%, var(--rp-thumb-l, 88%))' }}
    >
      <div className='absolute inset-0 flex items-center justify-center'>
        <svg
          viewBox='0 0 24 24'
          fill='none'
          stroke='rgba(100, 116, 139, 0.55)'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
          className='h-1/3 w-1/3'
        >
          <path d={glyph} />
        </svg>
      </div>
      {!failed && (
        <img
          src={thumbnailUrl(slug, id)}
          alt=''
          loading='lazy'
          onError={() => setFailed(true)}
          className='absolute inset-0 h-full w-full object-cover'
        />
      )}
    </div>
  )
}
