import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

function systemTheme(): Theme {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function currentTheme(): Theme {
  const stored = localStorage.getItem('rp-theme')
  return stored === 'dark' || stored === 'light' ? stored : systemTheme()
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

/** Light/dark switch - persisted, defaults to the system preference. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme())

  useEffect(() => {
    apply(theme)
  }, [theme])

  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('rp-theme', next)
    setTheme(next)
  }

  return (
    <button
      type='button'
      onClick={flip}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className='rp-btn rp-btn-ghost h-8 w-8 shrink-0 !px-0'
    >
      {theme === 'dark'
        ? (
          <svg
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.7'
            className='h-4 w-4'
            aria-hidden='true'
          >
            <circle cx='12' cy='12' r='4' />
            <path d='M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4' />
          </svg>
        )
        : (
          <svg
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.7'
            className='h-4 w-4'
            aria-hidden='true'
          >
            <path d='M21 12.8A8.5 8.5 0 1111.2 3a6.6 6.6 0 009.8 9.8z' />
          </svg>
        )}
    </button>
  )
}
