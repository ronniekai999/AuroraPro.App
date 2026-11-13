// A boundary that draws a fixed fallback in place of what it holds, once
// that has thrown. Used inside the error screen, which stands in for the app
// and has nothing above it but the root: a throw there would otherwise take
// the whole page down, update notice and all.

import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Drawn in place of the children once they have thrown. It must not be
   *  able to throw itself. */
  fallback: ReactNode
}

export class ErrorGuard extends Component<Props, { caught: boolean }> {
  state = { caught: false }

  // Anything can be thrown, null included: what was thrown is not kept,
  // only that something was.
  static getDerivedStateFromError(): { caught: boolean } {
    return { caught: true }
  }

  render() {
    return this.state.caught ? this.props.fallback : this.props.children
  }
}
