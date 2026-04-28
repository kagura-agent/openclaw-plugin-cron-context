# openclaw-plugin-cron-context

Inject cron job output back into the target channel's session context, so persistent sessions accumulate knowledge from isolated cron runs.

## Problem

OpenClaw cron jobs run in isolated sessions. Their output is delivered to Discord channels via `announce` delivery, but this is fire-and-forget — the message **does not enter the target channel's session context**. This means:

- The #study channel session never "sees" what study-loop crons produced
- Each cron run starts from zero with no knowledge of previous runs' output
- The persistent session loses continuity with its cron-produced content

## Solution

A plugin that hooks into `agent_end`, detects cron-triggered runs, extracts the final assistant output, and injects it into the target channel's session via `enqueueSystemEvent`. This way:

- Cron execution stays **isolated** (independent sessions, no shared state)
- Cron output **flows back** into the persistent channel session
- The channel session accumulates cron summaries as context for future turns

## Architecture

```
Cron run (isolated)
  → agent produces output
  → announce delivery sends to Discord channel (existing behavior)
  → [NEW] agent_end hook fires
    → parse sessionKey to extract cronJobId
    → read ~/.openclaw/cron/jobs.json for delivery target
    → construct target session key (agent:<agent>:discord:channel:<id>)
    → enqueueSystemEvent(summary, { sessionKey: targetSessionKey })
  → next time the channel session wakes, it has the cron output in context
```

## Status

🔬 Research phase — see [docs/research.md](docs/research.md) for feasibility analysis.

## License

MIT
