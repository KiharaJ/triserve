import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import type { WorkflowGraphWire } from '@/lib/types'
import { FLOWS, type Flow, type FlowStep } from './flows'

/**
 * /guide — how the service centre runs, one flow per role.
 *
 * Two halves, deliberately:
 *   - the LIFECYCLE diagram is read live from GET /workflow/graph, so it shows
 *     the company's ACTUAL configured stages. Job statuses are per-company
 *     data, so a hand-drawn picture here would start lying the moment an admin
 *     renamed a column;
 *   - the flows are curated prose (see ./flows.ts) — the ordering and the
 *     warnings are editorial and cannot be derived from config.
 *
 * Every step links to the screen that performs it: the question this page
 * exists to answer is "where do I go to do this", and prose alone doesn't
 * answer it.
 */
export function GuidePage() {
  const [tab, setTab] = useState(FLOWS[0].key)

  return (
    <div className="flex flex-col gap-6">
      {/* No <h1>: the app shell already titles the page from the nav label. */}
      <p className="max-w-3xl text-sm text-muted-foreground">
        A repair moves through the centre in one direction: the front desk takes
        it in, the workshop fixes it, the front desk hands it back, and
        aftersales gets paid for it. Pick your job below to see your part of
        that, step by step — every step links to the screen that does it.
      </p>

      <JobLifecycle />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          {FLOWS.map((f) => (
            <TabsTrigger key={f.key} value={f.key} className="text-xs">
              {f.title}
            </TabsTrigger>
          ))}
        </TabsList>
        {FLOWS.map((f) => (
          <TabsContent key={f.key} value={f.key}>
            <FlowView flow={f} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

/**
 * The company's configured job stages, in order, as a wrapping chip flow.
 *
 * Terminal states (CLOSED / CANCELLED / RETURNED_UNREPAIRED) are split out:
 * they are where a job ENDS, not the next step along, and inlining them makes
 * the happy path look like it runs through cancellation.
 */
function JobLifecycle() {
  const graph = useQuery({
    queryKey: ['workflow', 'graph'],
    queryFn: async () => (await api.get<WorkflowGraphWire>('/workflow/graph')).data,
  })

  const states = (graph.data?.states ?? []).filter((s) => s.active)
  const main = states.filter((s) => !s.is_terminal)
  const terminal = states.filter((s) => s.is_terminal)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">The life of a job</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {graph.isPending && (
          <p className="text-sm text-muted-foreground">Loading the stages…</p>
        )}
        {graph.isError && (
          <p className="text-sm text-muted-foreground">
            Could not load the stages — the flows below still apply.
          </p>
        )}
        {states.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-y-2">
              {main.map((s, i) => (
                <div key={s.id} className="flex items-center">
                  <span
                    className={
                      'rounded-full border px-2.5 py-1 text-xs font-medium ' +
                      (s.is_initial
                        ? 'border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-300'
                        : 'bg-muted')
                    }
                  >
                    {s.label}
                  </span>
                  {i < main.length - 1 && (
                    <ArrowRight className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </div>
              ))}
            </div>
            {terminal.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Ends at:</span>
                {terminal.map((s) => (
                  <span key={s.id} className="rounded-full border px-2.5 py-1 font-medium">
                    {s.label}
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              These are your company’s configured stages, read live — if an
              admin renames or adds one, it changes here too. A job only ever
              moves along a permitted step, and who may move it depends on the
              step.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** One role's flow: a numbered rail with a card per step. */
function FlowView({ flow }: { flow: Flow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{flow.title}</h2>
          <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + flow.accent.chip}>
            {flow.owner}
          </span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{flow.summary}</p>
      </div>

      <ol className="flex max-w-3xl flex-col">
        {flow.steps.map((step, i) => (
          <StepRow
            key={step.title}
            step={step}
            index={i + 1}
            accent={flow.accent}
            last={i === flow.steps.length - 1}
          />
        ))}
      </ol>
    </div>
  )
}

function StepRow({
  step,
  index,
  accent,
  last,
}: {
  step: FlowStep
  index: number
  accent: Flow['accent']
  last: boolean
}) {
  return (
    <li className="flex gap-3">
      {/* The rail: a numbered dot, and a line down to the next step. */}
      <div className="flex flex-col items-center">
        <span
          className={
            'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ' +
            accent.dot
          }
        >
          {index}
        </span>
        {!last && <span className={'my-1 w-1 flex-1 rounded-full ' + accent.line} aria-hidden />}
      </div>

      <div className={'min-w-0 flex-1 ' + (last ? 'pb-0' : 'pb-4')}>
        <Card>
          <CardContent className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{step.title}</span>
              {step.to && (
                <Link
                  to={step.to}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Open <ExternalLink className="size-3" />
                </Link>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{step.detail}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {step.who.map((w) => (
                <Badge key={w} variant="secondary" className="text-[11px] font-normal">
                  {w}
                </Badge>
              ))}
            </div>
            {step.watchOut && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>{step.watchOut}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </li>
  )
}
