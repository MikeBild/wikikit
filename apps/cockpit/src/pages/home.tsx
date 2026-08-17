import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, CircleCheckBig, Clock3 } from 'lucide-react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { useSpace } from '@/lib/space'

const STEPS = [
  { number: '01', title: 'Capture', question: 'What arrived?', to: '/inbox' as const },
  { number: '02', title: 'Triage', question: 'Where does it belong?', to: '/decisions' as const },
  { number: '03', title: 'Retrieve', question: 'What do we already know?', to: '/search' as const },
  { number: '04', title: 'Care', question: 'What needs repair?', to: '/care' as const },
  { number: '05', title: 'Check', question: 'Is it grounded and safe?', to: '/care' as const },
  { number: '06', title: 'Remember', question: 'What did people decide?', to: '/decision-log' as const },
] as const

export function HomePage() {
  const space = useSpace()
  const attention = useQuery({
    queryKey: keys.attention(space, { state: 'open', limit: 3 }),
    queryFn: () => wk.attention.list(space, { state: 'open', limit: 3 }),
  })

  return (
    <Page
      title={space}
      description="A clear loop for turning raw material into reviewed, useful knowledge."
      actions={
        <Button asChild>
          <Link to="/decisions" data-testid="home-open-decisions">
            Open decisions
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        {attention.data && (attention.data.counts.overdue > 0 || attention.data.counts.by_kind.care > 0) ? (
          <Alert tone="danger" title="Needs attention" data-testid="home-incident">
            <span>
              {attention.data.counts.overdue} overdue · {attention.data.counts.by_kind.care} care findings.{' '}
              <Link
                to="/decisions"
                data-testid="home-incident-open"
                className="font-medium underline underline-offset-4"
              >
                Open decisions
              </Link>
            </span>
          </Alert>
        ) : null}
        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]" aria-label="Needs attention">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CircleCheckBig /> Needs your attention
              </CardTitle>
              <CardDescription>The oldest unresolved work comes first.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {attention.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
              {attention.isError ? <Alert tone="danger" title="Attention could not be loaded" /> : null}
              {attention.data?.items.map((item, index) => (
                <Link
                  key={item.key}
                  to="/decisions"
                  data-testid={`home-attention-${index + 1}`}
                  className="hover:bg-muted flex items-center justify-between gap-4 rounded-md p-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground">{item.kind}</span>
                  </span>
                  <RelativeTime value={item.created_at} />
                </Link>
              ))}
              {attention.data?.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Queue at a glance</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <Metric label="Open" value={attention.data?.counts.open} />
              <Metric
                label="Overdue"
                value={attention.data?.counts.overdue}
                danger={Boolean(attention.data?.counts.overdue)}
              />
              <Metric
                label="Oldest"
                value={attention.data?.counts.oldest_days == null ? '—' : `${attention.data.counts.oldest_days}d`}
              />
              <Metric label="Proposals" value={attention.data?.counts.by_kind.proposal} />
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="knowledge-loop-heading">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 id="knowledge-loop-heading" className="text-sm font-semibold">
              The knowledge lifecycle
            </h2>
            <Clock3 className="text-muted-foreground" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {STEPS.map((step) => (
              <Link
                key={step.number}
                to={step.to}
                data-testid={`home-step-${step.number}`}
                className="group rounded-xl border bg-card p-4 transition-colors hover:bg-muted"
              >
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">{step.number}</span>
                <span className="mt-8 flex items-end justify-between gap-3">
                  <span>
                    <strong className="block">{step.title}</strong>
                    <span className="text-sm text-muted-foreground">{step.question}</span>
                  </span>
                  <ArrowRight className="transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        {attention.data?.recent_activity.length ? (
          <section aria-labelledby="recent-decisions-heading">
            <h2 id="recent-decisions-heading" className="mb-3 text-sm font-semibold">
              Recently decided
            </h2>
            <div className="flex flex-col gap-2">
              {attention.data.recent_activity.slice(0, 5).map((item, index) => (
                <Link
                  key={item.key}
                  to="/decisions"
                  data-testid={`home-recent-${index + 1}`}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span className="truncate">{item.title}</span>
                  <Badge tone="success">Decided</Badge>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Page>
  )
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string
  value: number | string | undefined
  danger?: boolean
}) {
  return (
    <Link to="/decisions" className="rounded-md p-1 hover:bg-muted" data-testid={`home-metric-${label.toLowerCase()}`}>
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className={danger ? 'block text-2xl font-semibold text-destructive' : 'block text-2xl font-semibold'}>
        {value ?? '—'}
      </span>
    </Link>
  )
}
