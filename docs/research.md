# Research: Cron Output → Session Context Injection

## Problem Statement

OpenClaw cron jobs running with `sessionTarget: "isolated"` produce output that is delivered to Discord channels via `announce` mode. However, this delivery only sends a Discord message — it does **not** inject the output into the target channel's persistent session context. This creates a continuity gap: the channel session never "remembers" what its cron jobs produced.

**Goal:** After an isolated cron run completes, automatically inject its output into the target channel's session context, without triggering an agent turn and without modifying OpenClaw core code.

## API Investigation

### 1. `agent_end` Plugin Hook

**Source:** `plugin-sdk/src/plugins/hook-types.d.ts`

```typescript
export type PluginHookAgentEndEvent = {
    runId?: string;
    messages: unknown[];  // Full conversation if allowConversationAccess is enabled
    success: boolean;
    error?: string;
    durationMs?: number;
};

export type PluginHookAgentContext = {
    runId?: string;
    agentId?: string;
    sessionKey?: string;    // e.g. "agent:kagura:cron:<jobId>:run:<runId>"
    sessionId?: string;
    workspaceDir?: string;
    trigger?: string;       // "cron" for cron-initiated runs
    channelId?: string;
    // ...
};
```

**Key findings:**
- ✅ `agent_end` fires for ALL agent runs, including cron
- ✅ `ctx.trigger` is `"cron"` for cron-initiated runs (verified via nudge plugin which filters these out with `skipTriggers`)
- ✅ `ctx.sessionKey` contains the cron job ID in format `agent:<agentId>:cron:<jobId>:run:<runId>`
- ⚠️ `event.messages` requires `allowConversationAccess: true` in plugin config to contain actual content
- ✅ `event.success` lets us skip failed runs

### 2. `enqueueSystemEvent` API

**Source:** `plugin-sdk/src/infra/system-events.d.ts`

```typescript
type SystemEventOptions = {
    sessionKey: string;          // Target session to inject into
    contextKey?: string | null;  // Dedup key (optional)
    deliveryContext?: DeliveryContext;
    trusted?: boolean;
};

export declare function enqueueSystemEvent(
    text: string, 
    options: SystemEventOptions
): boolean;
```

**Key findings:**
- ✅ Can target **any** session by sessionKey — not limited to main session
- ✅ Does NOT trigger an agent turn — events are consumed on next session activation
- ✅ Available via `api.runtime.system.enqueueSystemEvent` in plugin runtime
- ✅ Returns boolean indicating success
- ⚠️ Target session must exist (have been created at some point)

### 3. Cron Store File

**Location:** `~/.openclaw/cron/jobs.json`

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "d01fd149-...",
      "name": "study-loop",
      "delivery": {
        "mode": "announce",
        "channel": "discord",
        "to": "channel:1491644155451932934",
        "accountId": "kagura"
      },
      "sessionTarget": "isolated"
    }
  ]
}
```

**Key findings:**
- ✅ `delivery.channel` + `delivery.to` gives us the target channel
- ✅ Can construct session key: `agent:<agentId>:discord:channel:<channelId>`
- ✅ File is readable from plugin runtime (same process, same filesystem)
- ⚠️ No cron query API in plugin runtime — must read file directly
- ℹ️ `delivery.to` format is `channel:<id>` — need to extract the numeric ID

### 4. Session Key Pattern

Cron session key: `agent:kagura:cron:d01fd149-...:run:d9a8fa32-...`
- Job ID extractable via: `sessionKey.split(':cron:')[1].split(':run:')[0]`

Target session key: `agent:kagura:discord:channel:1491644155451932934`
- Constructed from: `agent:<agentId>:<delivery.channel>:<delivery.to>`

### 5. Plugin Configuration

**Source:** `plugin-sdk/src/config/types.plugins.d.ts`

```typescript
{
    allowConversationAccess?: boolean;  // Required for event.messages content
}
```

Must set `allowConversationAccess: true` in plugin config to access conversation content from `agent_end` events.

## Reference Implementation: nudge plugin

**Source:** `~/.openclaw/workspace/openclaw-plugin-nudge/index.ts`

The nudge plugin demonstrates the exact pattern we need:
- Hooks `agent_end` via `api.on("agent_end", handler)`
- Filters by `ctx.trigger` (skips cron/heartbeat)
- Uses `api.runtime.system.enqueueSystemEvent()` to inject content
- Manages state via filesystem

**Our plugin inverts the filter**: we ONLY process cron runs (where nudge skips them).

## Feasibility Assessment

| Requirement | Status | Notes |
|---|---|---|
| Detect cron runs in agent_end | ✅ | `ctx.trigger === "cron"` |
| Extract last assistant message | ⚠️ | Needs `allowConversationAccess: true` |
| Find cron job's delivery target | ✅ | Read `~/.openclaw/cron/jobs.json` |
| Construct target session key | ✅ | `agent:<agentId>:<channel>:channel:<id>` |
| Inject without triggering turn | ✅ | `enqueueSystemEvent` is passive |
| No OpenClaw code changes | ✅ | Pure plugin |

**Verdict: Feasible.** All required APIs exist and are accessible from the plugin runtime.

## Risks & Mitigations

1. **`event.messages` empty without config** → Document `allowConversationAccess: true` requirement
2. **Target session doesn't exist yet** → Gracefully skip; log warning. Sessions are created on first message.
3. **Cron store file format changes** → Pin to `version: 1`; add version check
4. **System event queue overflow** → Keep injected text concise (truncate if needed)
5. **`delivery.mode === "none"`** → Skip injection for crons that don't deliver anywhere

## Implementation Plan

1. Plugin scaffolding (`openclaw.plugin.json`, `index.ts`)
2. Cron store reader (parse jobs.json, extract delivery target by job ID)
3. Message extractor (last assistant text from `event.messages`)
4. Session key constructor
5. System event injection
6. Config: opt-in/opt-out per cron job name pattern
7. Testing with study-loop cron
