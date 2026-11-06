/** @jsxImportSource @opentui/solid */
import type {
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
} from "@opencode/client"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, Show } from "solid-js"

type Context = ReturnType<typeof usePlugin>

type Run = { start: number; end?: number }

const STORAGE_KEY = "agents_sidebar"
const HISTORY_PAGE_SIZE = 10

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

// Fixed hues keep the state word readable even when a theme's accent hue
// changes: purple for thinking, blue for tool calls, green for finished work.
const STATE_COLORS = {
  thinking: "#c792ea",
  tool: "#82aaff",
  done: "#7fd88f",
} as const

type Tracker = {
  root: (sessionID: string) => SessionInfo | undefined
  active: (sessionID: string) => SessionInfo[]
  latest: (sessionID: string) => SessionInfo[]
  history: (sessionID: string) => SessionInfo[]
  depth: (sessionID: string) => number
  run: (sessionID: string) => Run | undefined
  now: () => number
  breathing: () => number
  collapsed: () => boolean
  toggleCollapsed: () => void
  showHistory: () => boolean
  toggleHistory: () => void
  expanded: (sessionID: string, fallback: boolean) => boolean
  toggleExpanded: (sessionID: string, fallback: boolean) => void
  historyPage: (sessionID: string) => number
  setHistoryPage: (sessionID: string, page: number) => void
}

function agentName(session: SessionInfo) {
  const hit = (session.title ?? "").match(/\(@([^\s()]+)\s+subagent\)\s*$/)
  const name = hit?.[1] ?? session.agent ?? "agent"
  return name.length > 10 ? `${name.slice(0, 9)}~` : name
}

function agentDesc(session: SessionInfo) {
  const desc = (session.title ?? "").replace(/\s*\(@[^\s()]+\s+subagent\)\s*$/, "")
  return desc.length > 38 ? `${desc.slice(0, 37)}~` : desc
}

type ReviewVerdict = "APPROVED" | "REJECTED" | "BLOCKED"

// Reviewers end their answer with a `REVIEW_STATUS: APPROVED|REJECTED|BLOCKED`
// line. The template itself contains all three words separated by pipes, so the
// negative lookahead keeps that echoed line from being mistaken for a verdict.
const REVIEW_STATUS = /REVIEW_STATUS\s*:\s*(APPROVED|REJECTED|BLOCKED)(?!\s*\|)/gi

// Reads a labeled block such as `NEXT_SLICE:` and joins its lines into one
// short sentence, stopping at the next ALL_CAPS label (FINDINGS, REQUIRED_FIXES…).
function sectionValue(text: string, label: string) {
  const pattern = new RegExp(`${label}\\s*:`, "gi")
  let start = -1
  for (const match of text.matchAll(pattern)) start = (match.index ?? 0) + match[0].length
  if (start < 0) return undefined
  const rest = text.slice(start)
  const stop = rest.search(/\n\s*[A-Z][A-Z_]{2,}\s*:/)
  const body = (stop === -1 ? rest : rest.slice(0, stop))
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim()
  return body || undefined
}

function shortText(text: string, max = 44) {
  return text.length > max ? `${text.slice(0, max - 1)}~` : text
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return `${value}`
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function toolSummary(part: SessionMessageAssistantTool) {
  const input: Record<string, unknown> = part.state.status === "streaming" ? {} : part.state.input
  const detail =
    input.command ??
    input.description ??
    input.filePath ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    ""
  const text = detail ? `${part.name} ${String(detail)}` : part.name
  return text.length > 30 ? `${text.slice(0, 29)}~` : text
}

function createTracker(context: Context): { tracker: Tracker; dispose: () => void } {
  return createRoot((dispose) => {
    const [ui, setUi] = context.storage.store(STORAGE_KEY, {
      initial: { collapsed: true, showHistory: false },
    })
    const [runs, setRuns] = createSignal<Record<string, Run>>({})
    const [now, setNow] = createSignal(Date.now())
    const [breathing, setBreathing] = createSignal(0)
    const [expandedMap, setExpandedMap] = createSignal<Record<string, boolean>>({})
    const [historyPageMap, setHistoryPageMap] = createSignal<Record<string, number>>({})
    const hydrated = new Set<string>()

    function isDone(session: SessionInfo) {
      if (context.data.session.status(session.id) === "running") return false
      if (runs()[session.id]?.end !== undefined) return true
      // Sessions loaded from disk have no run entry in this process. Their
      // idle timestamp (or outcome) is enough to keep them out of the active
      // list instead of showing the same subagent twice for 30 seconds.
      if (session.outcome !== undefined || session.time.idle !== undefined) return true
      return now() - session.time.created >= 30_000
    }

    function hydrate(sessionID: string) {
      if (hydrated.has(sessionID)) return
      hydrated.add(sessionID)
      void context.data.session.message.sync(sessionID).catch(() => {})
    }

    // Every session below the root, at any nesting depth. `family()` only holds
    // sessions the client has synced, so walk the parent links as a fallback.
    function descendants(sessionID: string) {
      const rootID = context.data.session.root(sessionID)
      const list = context.data.session.list()
      const known = new Set([rootID])
      let changed = true
      while (changed) {
        changed = false
        for (const session of list) {
          if (!session.parentID || known.has(session.id)) continue
          if (!known.has(session.parentID)) continue
          known.add(session.id)
          changed = true
        }
      }
      known.delete(rootID)
      return list.filter((session) => known.has(session.id))
    }

    function depthOf(sessionID: string) {
      const rootID = context.data.session.root(sessionID)
      let depth = 0
      let current = context.data.session.get(sessionID)
      const seen = new Set<string>()
      while (current?.parentID && current.id !== rootID && !seen.has(current.id)) {
        seen.add(current.id)
        depth += 1
        current = context.data.session.get(current.parentID)
      }
      return depth
    }

    function agentKey(session: SessionInfo) {
      const hit = (session.title ?? "").match(/\(@([^\s()]+)\s+subagent\)\s*$/)
      return hit?.[1] ?? session.agent ?? "agent"
    }

    function endedAt(session: SessionInfo) {
      return runs()[session.id]?.end ?? session.time.updated
    }

    // Keep one completed row per sub-agent visible (dimmed) so an idle agent
    // does not vanish. If that agent is currently running, the active row is
    // the visible one and its previous runs belong to history.
    function latestDone(sessionID: string) {
      const busy = new Set(
        descendants(sessionID)
          .filter((session) => !isDone(session))
          .map((session) => agentKey(session)),
      )
      const latest = new Map<string, SessionInfo>()
      for (const session of descendants(sessionID)) {
        if (!isDone(session)) continue
        const key = agentKey(session)
        if (busy.has(key)) continue
        const current = latest.get(key)
        if (!current || endedAt(session) > endedAt(current)) latest.set(key, session)
      }
      return [...latest.values()].sort((a, b) => endedAt(b) - endedAt(a))
    }

    function historySessions(sessionID: string) {
      const visible = new Set(latestDone(sessionID).map((session) => session.id))
      return descendants(sessionID)
        .filter((session) => isDone(session) && !visible.has(session.id))
        .sort((a, b) => endedAt(b) - endedAt(a))
    }

    // Seed subagents that predate the TUI: they are absent from the client data
    // store until something syncs them by id.
    void context.client.session
      .list({})
      .then((response) => {
        for (const session of response.data ?? []) {
          if (!session.parentID) continue
          if (context.data.session.get(session.id)) continue
          void context.data.session.sync(session.id).catch(() => {})
        }
      })
      .catch(() => {})

    const timer = setInterval(() => setNow(Date.now()), 1000)
    const breathingTimer = setInterval(() => setBreathing((value) => value + 1), 400)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(breathingTimer)
    })

    createEffect(() => {
      for (const session of context.data.session.list()) {
        const busy = context.data.session.status(session.id) === "running"
        setRuns((current) => {
          const run = current[session.id]
          if (busy && (!run || run.end !== undefined)) return { ...current, [session.id]: { start: Date.now() } }
          if (!busy && run && run.end === undefined) return { ...current, [session.id]: { ...run, end: Date.now() } }
          return current
        })
        if (session.parentID && !busy && context.data.session.message.list(session.id).length === 0) {
          hydrate(session.id)
        }
      }
    })

    return {
      dispose,
      tracker: {
        root(sessionID) {
          return context.data.session.get(context.data.session.root(sessionID)) ?? context.data.session.get(sessionID)
        },
        active(sessionID) {
          return descendants(sessionID)
            .filter((session) => !isDone(session))
            .sort((a, b) => a.time.created - b.time.created)
        },
        latest(sessionID) {
          return latestDone(sessionID)
        },
        history(sessionID) {
          return historySessions(sessionID)
        },
        depth(sessionID) {
          return depthOf(sessionID)
        },
        run(sessionID) {
          return runs()[sessionID]
        },
        now,
        breathing,
        collapsed() {
          return ui.collapsed
        },
        toggleCollapsed() {
          void setUi((draft) => {
            draft.collapsed = !draft.collapsed
          })
        },
        showHistory() {
          return ui.showHistory ?? false
        },
        toggleHistory() {
          void setUi((draft) => {
            draft.showHistory = !(draft.showHistory ?? false)
          })
        },
        expanded(sessionID, fallback) {
          return expandedMap()[sessionID] ?? fallback
        },
        toggleExpanded(sessionID, fallback) {
          const next = !(expandedMap()[sessionID] ?? fallback)
          setExpandedMap((current) => ({ ...current, [sessionID]: next }))
        },
        historyPage(sessionID) {
          const total = historySessions(sessionID).length
          const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))
          return Math.min(historyPageMap()[sessionID] ?? 0, pages - 1)
        },
        setHistoryPage(sessionID, page) {
          const total = historySessions(sessionID).length
          const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))
          const clamped = Math.max(0, Math.min(page, pages - 1))
          setHistoryPageMap((current) => ({ ...current, [sessionID]: clamped }))
        },
      },
    }
  })
}

function Agent(props: {
  tracker: Tracker
  session: SessionInfo
  primary?: boolean
  current?: boolean
  depth?: number
}) {
  const context = usePlugin()
  const theme = () => context.theme

  const status = createMemo(() => context.data.session.status(props.session.id))
  const messages = createMemo(() => context.data.session.message.list(props.session.id))
  const lastAssistant = createMemo(() =>
    messages().findLast((item): item is SessionMessageAssistant => item.type === "assistant"),
  )
  const running = createMemo(() =>
    (lastAssistant()?.content ?? []).some(
      (item) => item.type === "tool" && (item.state.status === "running" || item.state.status === "streaming"),
    ),
  )
  const tool = createMemo(() =>
    lastAssistant()?.content.findLast((item): item is SessionMessageAssistantTool => item.type === "tool"),
  )
  const state = createMemo(() => {
    if (status() === "running") {
      if (running()) return { label: "tool", color: STATE_COLORS.tool }
      return { label: "thinking", color: STATE_COLORS.thinking }
    }
    if (lastAssistant()?.finish) return { label: "done", color: STATE_COLORS.done }
    return { label: "idle", color: theme().text.muted }
  })
  const stateAbbr = createMemo(() => {
    const table: Record<string, string> = {
      thinking: "think",
      tool: "tool",
      done: "done",
      idle: "idle",
    }
    return table[state().label] ?? state().label
  })
  const model = createMemo(() => lastAssistant()?.model.id ?? props.session.model?.id ?? "?")
  const ctx = createMemo(() => {
    const item = messages().findLast(
      (message): message is SessionMessageAssistant =>
        message.type === "assistant" && (message.tokens?.output ?? 0) > 0,
    )
    const tokens = item?.tokens
    if (!tokens) return undefined
    return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  })
  const elapsedMs = createMemo(() => {
    const run = props.tracker.run(props.session.id)
    if (run) return (run.end ?? props.tracker.now()) - run.start
    const last = lastAssistant()
    const end = last?.time.completed ?? last?.time.created ?? props.session.time.updated
    return end > props.session.time.created ? end - props.session.time.created : undefined
  })
  const open = createMemo(() => props.tracker.expanded(props.session.id, false))
  const nameColor = createMemo(() => {
    if (props.primary) return theme().text.base
    const label = state().label
    return label === "thinking" || label === "tool" ? theme().text.base : theme().text.muted
  })
  const review = createMemo(() => {
    const items = messages()
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const message = items[index]
      if (message.type !== "assistant") continue
      const text = message.content
        .filter((item): item is SessionMessageAssistantText => item.type === "text")
        .map((item) => item.text)
        .join("\n")
      const matches = [...text.matchAll(REVIEW_STATUS)]
      const hit = matches[matches.length - 1]?.[1]
      if (hit) {
        return {
          verdict: hit.toUpperCase() as ReviewVerdict,
          next: sectionValue(text, "NEXT_SLICE"),
        }
      }
    }
    return undefined
  })
  const verdict = () => review()?.verdict
  const nextSlice = () => {
    const value = review()
    return value?.verdict === "APPROVED" ? value.next : undefined
  }
  const verdictColor = createMemo(() => {
    const value = verdict()
    if (value === "APPROVED") return STATE_COLORS.done
    if (value === "REJECTED") return theme().text.feedback.error.base
    if (value === "BLOCKED") return theme().text.feedback.warning.base
    return theme().text.muted
  })

  // Breathing indicator (ASCII only), driven by the tracker's 400ms `breathing` tick.
  const phase = createMemo(() => props.tracker.breathing() % 4)
  const indicator = createMemo(() => {
    const label = state().label
    if (label === "thinking" || label === "tool") return [".", "o", "O", "o"][phase()]
    return "-"
  })

  return (
    <box marginBottom={1} marginLeft={props.primary ? 0 : Math.max(0, (props.depth ?? 1) - 1) * 2}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => props.tracker.toggleExpanded(props.session.id, false)}
        >
          <text fg={state().color}>{indicator()}</text>
          <text fg={nameColor()}>
            <b>[{agentName(props.session)}]</b>
          </text>
          <text fg={state().color}>{stateAbbr()}</text>
          <text fg={theme().text.muted}>
            {ctx() !== undefined ? formatTokens(ctx()!) : "-"}{" "}
            {elapsedMs() !== undefined ? formatElapsed(elapsedMs()!) : "-"}
          </text>
        </box>
        <Show when={!props.current}>
          <box onMouseDown={() => context.ui.router.navigate({ type: "session", sessionID: props.session.id })}>
            <text fg={theme().hue.interactive[200]}>[view]</text>
          </box>
        </Show>
      </box>
      <Show when={!props.primary}>
        <text fg={theme().text.muted}>  {agentDesc(props.session)}</text>
      </Show>
      <Show when={verdict()}>
        {(value) => (
          <text fg={verdictColor()}>  review: {value().toLowerCase()}</text>
        )}
      </Show>
      <Show when={nextSlice()}>
        {(value) => <text fg={STATE_COLORS.tool}>  next: {shortText(value())}</text>}
      </Show>
      <Show when={open()}>
        <text fg={theme().text.muted}>  model: {model()}</text>
        <text fg={theme().text.muted}>  tool: {tool() ? toolSummary(tool()!) : "-"}</text>
        <text fg={theme().text.muted}>  cost: {money.format(props.session.cost ?? 0)}</text>
      </Show>
    </box>
  )
}

function Divider(props: { label?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  return (
    <box marginTop={1}>
      <text fg={theme().text.muted}>{(props.label ? `── ${props.label} ` : "") + "────────────────────────────────"}</text>
    </box>
  )
}

function View(props: { tracker: Tracker; session_id: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const root = createMemo(() => props.tracker.root(props.session_id))
  const active = createMemo(() => props.tracker.active(props.session_id))
  const latest = createMemo(() => props.tracker.latest(props.session_id))
  const history = createMemo(() => props.tracker.history(props.session_id))
  const total = () => active().length + latest().length + history().length
  const historyTotalPages = createMemo(() => Math.max(1, Math.ceil(history().length / HISTORY_PAGE_SIZE)))
  const historyPage = createMemo(() => props.tracker.historyPage(props.session_id))
  const historyItems = createMemo(() => {
    const start = historyPage() * HISTORY_PAGE_SIZE
    return history().slice(start, start + HISTORY_PAGE_SIZE)
  })

  return (
    <box marginBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleCollapsed()}>
        <text fg={theme().text.base}>{props.tracker.collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text.base}>
          <b>Agents</b>
        </text>
        <text fg={theme().text.muted}>
          {root() ? "1 primary " : ""}
          {active().length} active
        </text>
      </box>
      <Show when={!props.tracker.collapsed()}>
        <Divider label="Primary" />
        <Show when={root()}>
          {(session) => (
            <Agent
              tracker={props.tracker}
              session={session()}
              primary
              current={session().id === props.session_id}
            />
          )}
        </Show>
        <Divider label="Sub Agents" />
        <Show when={total() > 0} fallback={<text fg={theme().text.muted}>No subagents yet</text>}>
          <Show when={history().length > 0}>
            <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleHistory()}>
              <text fg={props.tracker.showHistory() ? theme().hue.interactive[200] : theme().text.muted}>
                {props.tracker.showHistory() ? "[x]" : "[ ]"}
              </text>
              <text fg={theme().text.muted}>history ({history().length})</text>
            </box>
          </Show>
          <For each={active()}>
            {(child) => (
              <Agent
                tracker={props.tracker}
                session={child}
                current={child.id === props.session_id}
                depth={props.tracker.depth(child.id)}
              />
            )}
          </For>
          <For each={latest()}>
            {(child) => (
              <Agent
                tracker={props.tracker}
                session={child}
                current={child.id === props.session_id}
                depth={props.tracker.depth(child.id)}
              />
            )}
          </For>
          <Show when={props.tracker.showHistory()}>
            <For each={historyItems()}>
              {(child) => (
                <Agent
                  tracker={props.tracker}
                  session={child}
                  current={child.id === props.session_id}
                  depth={props.tracker.depth(child.id)}
                />
              )}
            </For>
            <Show when={historyTotalPages() > 1}>
              <box flexDirection="row" gap={1}>
                <text
                  fg={historyPage() > 0 ? theme().hue.interactive[200] : theme().text.muted}
                  onMouseDown={() => props.tracker.setHistoryPage(props.session_id, historyPage() - 1)}
                >
                  [&lt;]
                </text>
                <text fg={theme().text.muted}>
                  {historyPage() + 1}/{historyTotalPages()}
                </text>
                <text
                  fg={historyPage() < historyTotalPages() - 1 ? theme().hue.interactive[200] : theme().text.muted}
                  onMouseDown={() => props.tracker.setHistoryPage(props.session_id, historyPage() + 1)}
                >
                  [&gt;]
                </text>
              </box>
            </Show>
          </Show>
        </Show>
        <Divider />
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "agents-sidebar",
  setup(context) {
    const { tracker, dispose } = createTracker(context)
    const remove = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <View tracker={tracker} session_id={sessionID} />,
    })
    return () => {
      remove()
      dispose()
    }
  },
})
