import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { DataState } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { Fact } from '@/components/fact'
import { Alert } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs } from '@/components/ui/tabs'
import { LOCALE_TAGS } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n-context'
import { useSpace } from '@/lib/space'
import { useTheme } from '@/lib/theme'
import { TOKENS } from '@/lib/tokens'
import { formatCount, formatCurrency, formatRatio, unpricedModels, usageSeries } from '@/pages/model-usage.logic'

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  )
}

export function ModelUsagePage() {
  const space = useSpace()
  const { t, locale, dateTime } = useI18n()
  const { resolved } = useTheme()
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens')
  const localeTag = LOCALE_TAGS[locale]
  const palette = TOKENS[resolved]
  const current = useQuery({ queryKey: keys.stats(space, 'llm'), queryFn: () => wk.stats.llm(space) })
  const all = useQuery({ queryKey: keys.llmAllStats(), queryFn: () => wk.stats.llmAll() })

  return (
    <Page title="Model usage" description="Measured model tokens, configured cost and cache use over time.">
      <div className="flex min-w-0 flex-col gap-4">
        <Card data-testid="model-usage-current">
          <CardHeader className="border-b">
            <CardTitle>{t('modelUsage.current.title')}</CardTitle>
            <CardDescription>{t('modelUsage.current.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState testId="model-usage-space" query={current} skeleton={<UsageSkeleton />}>
              {(data) => {
                const series = usageSeries(data.buckets, localeTag)
                const unknown = data.totals.unpriced
                return (
                  <div className="flex min-w-0 flex-col gap-4">
                    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Fact
                        testId="model-usage-calls"
                        label={t('modelUsage.calls')}
                        value={formatCount(data.totals.calls, localeTag)}
                      />
                      <Fact
                        testId="model-usage-tokens"
                        label={t('modelUsage.tokens')}
                        value={formatCount(data.totals.tokens.total, localeTag)}
                        hint={t('modelUsage.tokens.hint', {
                          input: formatCount(data.totals.tokens.input, localeTag),
                          output: formatCount(data.totals.tokens.output, localeTag),
                        })}
                      />
                      <Fact
                        testId="model-usage-cost"
                        label={t('modelUsage.cost')}
                        value={formatCurrency(data.totals.cost_usd.total, data.totals.calls, unknown.calls, localeTag)}
                        hint={t('modelUsage.cost.hint')}
                      />
                      <Fact
                        testId="model-usage-cache"
                        label={t('modelUsage.cache')}
                        value={formatRatio(data.totals.cache_hit_ratio, localeTag)}
                        hint={t('modelUsage.cache.hint')}
                      />
                    </dl>

                    {unknown.calls > 0 ? (
                      <Alert tone="warning" title={t('modelUsage.unpriced.title')} data-testid="model-usage-unpriced">
                        {t('modelUsage.unpriced.description', {
                          calls: formatCount(unknown.calls, localeTag),
                          tokens: formatCount(unknown.tokens.total, localeTag),
                          models: unpricedModels(unknown.models),
                        })}
                      </Alert>
                    ) : null}

                    <Tabs
                      value={metric}
                      onValueChange={setMetric}
                      data-testid="model-usage-metric"
                      tabs={[
                        { id: 'tokens', label: t('modelUsage.chart.tokens') },
                        { id: 'cost', label: t('modelUsage.chart.cost') },
                      ]}
                    />
                    <div
                      className="h-80 min-w-0"
                      role="img"
                      aria-label={t(
                        metric === 'tokens' ? 'modelUsage.chart.tokensLabel' : 'modelUsage.chart.costLabel',
                      )}
                      data-testid="model-usage-chart"
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={series} margin={{ top: 12, right: 12, bottom: 8, left: 4 }}>
                          <CartesianGrid stroke={palette.border} vertical={false} />
                          <XAxis
                            dataKey="label"
                            stroke={palette['muted-foreground']}
                            tickLine={false}
                            minTickGap={28}
                          />
                          <YAxis
                            yAxisId="value"
                            stroke={palette['muted-foreground']}
                            tickLine={false}
                            tickFormatter={(value: number) =>
                              metric === 'cost' ? formatCurrency(value, 0, 0, localeTag) : formatCount(value, localeTag)
                            }
                          />
                          <YAxis yAxisId="unknown" orientation="right" hide />
                          <Tooltip
                            contentStyle={{
                              background: palette.popover,
                              borderColor: palette.border,
                              color: palette['popover-foreground'],
                            }}
                            formatter={(value, name) => [
                              metric === 'cost' && name === t('modelUsage.chart.knownCost')
                                ? formatCurrency(Number(value), 0, 0, localeTag)
                                : formatCount(Number(value), localeTag),
                              name,
                            ]}
                          />
                          <Legend />
                          {metric === 'tokens' ? (
                            <>
                              <Line
                                yAxisId="value"
                                type="monotone"
                                dataKey="input"
                                name={t('modelUsage.chart.input')}
                                stroke={palette['chart-1']}
                                dot={false}
                              />
                              <Line
                                yAxisId="value"
                                type="monotone"
                                dataKey="output"
                                name={t('modelUsage.chart.output')}
                                stroke={palette['chart-2']}
                                dot={false}
                              />
                              <Line
                                yAxisId="value"
                                type="monotone"
                                dataKey="cacheRead"
                                name={t('modelUsage.chart.cache')}
                                stroke={palette['chart-3']}
                                dot={false}
                              />
                            </>
                          ) : (
                            <>
                              <Line
                                yAxisId="value"
                                type="monotone"
                                dataKey="cost"
                                name={t('modelUsage.chart.knownCost')}
                                stroke={palette['chart-1']}
                                connectNulls={false}
                                dot={{ r: 2 }}
                              />
                              <Bar
                                yAxisId="unknown"
                                dataKey="unpricedCalls"
                                name={t('modelUsage.chart.unpriced')}
                                fill={palette.warning}
                                opacity={0.55}
                              />
                            </>
                          )}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-muted-foreground text-xs" data-testid="model-usage-window">
                      {t('modelUsage.window', {
                        bucket: t(`modelUsage.bucket.${data.bucket}`),
                        from: dateTime(data.from),
                        to: dateTime(data.to),
                      })}
                    </p>
                  </div>
                )
              }}
            </DataState>
          </CardContent>
        </Card>

        <Card data-testid="model-usage-all">
          <CardHeader className="border-b">
            <CardTitle>{t('modelUsage.all.title')}</CardTitle>
            <CardDescription>{t('modelUsage.all.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              testId="model-usage-all-data"
              query={all}
              skeleton={<UsageSkeleton />}
              isEmpty={(data) => data.per_space.length === 0}
              empty={
                <EmptyState
                  framed={false}
                  title={t('modelUsage.all.empty.title')}
                  description={t('modelUsage.all.empty.description')}
                  data-testid="model-usage-all-empty"
                />
              }
            >
              {(data) => (
                <div className="flex min-w-0 flex-col gap-4">
                  <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Fact
                      label={t('modelUsage.calls')}
                      value={formatCount(data.totals.calls, localeTag)}
                      testId="model-usage-all-calls"
                    />
                    <Fact
                      label={t('modelUsage.tokens')}
                      value={formatCount(data.totals.tokens.total, localeTag)}
                      testId="model-usage-all-tokens"
                    />
                    <Fact
                      label={t('modelUsage.cost')}
                      value={formatCurrency(
                        data.totals.cost_usd.total,
                        data.totals.calls,
                        data.totals.unpriced.calls,
                        localeTag,
                      )}
                      testId="model-usage-all-cost"
                    />
                    <Fact
                      label={t('modelUsage.cache')}
                      value={formatRatio(data.totals.cache_hit_ratio, localeTag)}
                      testId="model-usage-all-cache"
                    />
                  </dl>
                  {data.totals.unpriced.calls > 0 ? (
                    <Alert tone="warning" title={t('modelUsage.unpriced.title')} data-testid="model-usage-all-unpriced">
                      {t('modelUsage.unpriced.description', {
                        calls: formatCount(data.totals.unpriced.calls, localeTag),
                        tokens: formatCount(data.totals.unpriced.tokens.total, localeTag),
                        models: unpricedModels(data.totals.unpriced.models),
                      })}
                    </Alert>
                  ) : null}
                  <div className="flex flex-col gap-3">
                    {data.per_space.map((row) => (
                      <Link
                        key={row.space}
                        to="/model-usage"
                        search={{ space: row.space }}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg border border-border p-3 hover:bg-muted/50"
                        data-testid={`model-usage-space-${row.space}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{row.name}</span>
                          <span className="text-muted-foreground block truncate font-mono text-xs">{row.space}</span>
                        </span>
                        <span className="text-right tabular-nums">
                          <span className="block font-medium">
                            {formatCurrency(
                              row.totals.cost_usd.total,
                              row.totals.calls,
                              row.totals.unpriced.calls,
                              localeTag,
                            )}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {t('modelUsage.calls.value', { count: formatCount(row.totals.calls, localeTag) })}
                          </span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </DataState>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
