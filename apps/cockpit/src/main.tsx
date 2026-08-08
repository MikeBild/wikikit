import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionGate } from '@/components/session-gate'
import { ToastProvider } from '@/components/ui/toast'
import { createQueryClient } from '@/lib/query'
import { router } from '@/router'
import './index.css'

// The gate is OUTSIDE the router on purpose: a route that renders before the
// session resolves would fetch with no credential, take a 401, and show the
// operator a page full of individual failures instead of one sign-in prompt.
const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      {/* Outside the gate on purpose: a toast raised while signing out, or
          while the session is still resolving, still has a viewport to land
          in. The viewport portals to document.body, so where it is mounted
          decides nothing about where it appears. */}
      <ToastProvider>
        <SessionGate>
          <RouterProvider router={router} />
        </SessionGate>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
