import { useSyncExternalStore } from 'react'
import {
  createToastStore,
  toastForFailure,
  type ToastInput,
  type ToastRecord,
  type ToastStore,
} from '@/lib/toast-store'

/**
 * The browser half of the toast store, and the React binding.
 *
 * Same split as the theme: `lib/toast-store.ts` is the pure module (the tones,
 * the durations, the queue, the eviction rule) and this file supplies the two
 * browser facts it needs plus the one instance the tab has.
 *
 * ONE store, deliberately not a context. A toast is raised from a mutation's
 * `onError`, which is a callback with no component around it, from a dialog
 * that is about to unmount, and from a route that is being navigated away from
 * — none of those can reach a provider by the time they have something to say,
 * and the one this console loses most often is exactly the error raised by a
 * mutation whose dialog closes on settle.
 */
const store: ToastStore = createToastStore({
  now: () => Date.now(),
  schedule: (task, ms) => window.setTimeout(task, ms),
  cancel: (handle) => window.clearTimeout(handle),
})

export type { ToastInput, ToastRecord, ToastTone } from '@/lib/toast-store'

/**
 * Raise a toast. Callable from anywhere, including outside React.
 *
 * Returns the id, which is what a caller keeps if it intends to dismiss the
 * toast itself — a long-running action that reports its own outcome, say.
 */
export function toast(input: ToastInput): number {
  return store.raise(input)
}

/** One toast by id, or the whole corner when called with nothing. */
export function dismissToast(id?: number): void {
  store.dismiss(id)
}

/**
 * A failed request, as a toast, with the server's words intact.
 *
 * The title is the caller's — only the call site knows what was being attempted.
 * The sentence and the `next_best_actions` are the server's and are not
 * rewritten (CUI-LOAD-2). `ApiError` from `api/client.ts` satisfies the
 * structural shape `toastForFailure` reads, which is how the pure store stays
 * free of the network layer.
 */
export function toastFailure(title: string, error: unknown): number {
  return store.raise(toastForFailure(title, error))
}

/** The queue, for the one component that renders it. */
export function useToasts(): readonly ToastRecord[] {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

/**
 * The hook form, for call sites that prefer one.
 *
 * It returns the same module-level functions rather than bound copies: there is
 * one queue, and a hook that appeared to scope it to a component would be
 * lying about what happens when that component unmounts mid-request.
 */
export function useToast(): { toast: typeof toast; dismiss: typeof dismissToast; failure: typeof toastFailure } {
  return { toast, dismiss: dismissToast, failure: toastFailure }
}
