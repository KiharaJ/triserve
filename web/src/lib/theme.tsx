import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'triserve.theme'

interface ThemeContextValue {
  theme: Theme
  /** The actually-applied appearance after resolving 'system'. */
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function resolve(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

function apply(resolved: 'light' | 'dark'): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

/**
 * Theme provider (light / dark / system). Persists the choice to localStorage
 * and toggles the `.dark` class on <html> that the design tokens key off.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
    return stored ?? 'system'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolve(theme),
  )

  useEffect(() => {
    const r = resolve(theme)
    setResolved(r)
    apply(r)
  }, [theme])

  // Follow the OS when in 'system' mode.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const r = systemPrefersDark() ? 'dark' : 'light'
      setResolved(r)
      apply(r)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = (t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t)
    setThemeState(t)
  }

  const toggle = () => setTheme(resolved === 'dark' ? 'light' : 'dark')

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
