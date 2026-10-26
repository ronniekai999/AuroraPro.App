// ErrorBoundary — top-level React error boundary.
//
// 2026-05-19 audit (FE-H1) — the SPA previously had NO error boundary
// anywhere. A render-time throw in the ~6,000-line component tree
// would unmount the whole app and leave the user staring at a blank
// white page with no way to recover except a hard refresh. This
// component catches the throw, logs a stack to console (dev only),
// and renders an inline fallback with a reload button so the user
// gets a clear next step instead of an opaque void.
//
// React 19 ships a useErrorBoundary hook but it's still in beta;
// class components remain the documented stable way to implement
// the boundary contract (componentDidCatch + getDerivedStateFromError).
//
// We intentionally do NOT auto-redirect or auto-reload — both
// behaviors silently lose the user's in-flight state (e.g. a video
// they were watching, an admin form they were filling out). The
// reload button is opt-in.

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { announceStaleBundle, isStaleBundleError } from '@/lib/buildUpdate'

interface Props {
  children: ReactNode
  /**
   * Optional override for the fallback UI. Receives the captured
   * error and a retry callback that resets the boundary's internal
   * state — use this for per-route boundaries that should let the
   * user back into the route after a transient error.
   */
  fallback?: (error: Error, retry: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Dev: surface stack to console for debugging.
    // Prod: still log but with no stack — prevents internal-detail
    // leakage if a console snapshot ends up in a bug report.
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] caught', error, info.componentStack)
    } else {
      console.error('[ErrorBoundary] caught', error.message)
    }
    // A lazy view whose chunk a deploy deleted: let the update notice check
    // now rather than at its next timer tick.
    if (isStaleBundleError(error)) announceStaleBundle()
  }

  retry = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) {
      return this.props.fallback(error, this.retry)
    }

    // A chunk of the build this tab started with is gone: Aurora was updated
    // while the page was open (each deploy deletes the previous build's
    // files). Retrying cannot help, since the browser keeps the failed import,
    // so the only way forward offered is a reload.
    const stale = isStaleBundleError(error)

    // Default fallback. Kept inline + minimal so it doesn't depend
    // on Tailwind classes, fonts, or other app chrome — it has to
    // render even if the failure was in the styling layer.
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0f',
          color: '#e9e9f0',
          fontFamily: 'system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, marginBottom: 12, fontWeight: 600 }}>
            {stale ? 'Aurora was updated' : 'Aurora hit an unexpected error'}
          </h1>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 24, lineHeight: 1.5 }}>
            {stale
              ? 'This page was opened before the latest update, and part of it can no longer load. Reload to use the current version. Your data is safe.'
              : 'Something went wrong rendering this page. Your data is safe — only the in-memory view is affected.'}
          </p>
          {import.meta.env.DEV && (
            <pre
              style={{
                textAlign: 'left',
                background: '#1a1a24',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                overflow: 'auto',
                marginBottom: 24,
                maxHeight: 200,
              }}
            >
              {error.message}
              {error.stack && '\n\n' + error.stack}
            </pre>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: '#7c3aed',
              color: 'white',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 14,
              cursor: 'pointer',
              fontWeight: 500,
              marginRight: 8,
            }}
          >
            Reload page
          </button>
          {!stale && <button
            type="button"
            onClick={this.retry}
            style={{
              background: 'transparent',
              color: '#e9e9f0',
              border: '1px solid rgba(255,255,255,0.2)',
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>}
        </div>
      </div>
    )
  }
}
