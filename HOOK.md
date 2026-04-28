# cron-context

Injects isolated cron job output back into the target channel's persistent session context.

## What it does

When a cron job with `sessionTarget: "isolated"` completes, this plugin extracts the final assistant output and injects it as a system event into the target channel's session. This way the channel session accumulates cron summaries as context for future turns.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `include` | `string[]` | `["*"]` | Cron job name patterns to include (glob) |
| `exclude` | `string[]` | `[]` | Cron job name patterns to exclude (glob) |
| `maxLength` | `number` | `4000` | Max characters per injected cron output |
| `maxEventsPerSession` | `number` | `5` | Max pending events per target session |
| `prefix` | `string` | `[Cron output from {cronName}]` | Prefix for injected text |

## Requirements

- `allowConversationAccess: true` in plugin hooks config (needed to read agent output)
