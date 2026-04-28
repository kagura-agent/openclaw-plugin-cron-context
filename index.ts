import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface CronContextConfig {
  include?: string[];
  exclude?: string[];
  maxLength?: number;
  maxEventsPerSession?: number;
  prefix?: string;
}

interface CronJob {
  id: string;
  name: string;
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
  };
  sessionTarget?: string;
}

interface CronStoreFile {
  version: number;
  jobs: CronJob[];
}

/**
 * Simple glob matching (only supports * wildcard)
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return regex.test(value);
}

/**
 * Load cron jobs from the store file
 */
function loadCronJobs(openclawDir: string): CronStoreFile | null {
  const storePath = join(openclawDir, "cron", "jobs.json");
  try {
    if (!existsSync(storePath)) return null;
    const data = JSON.parse(readFileSync(storePath, "utf-8"));
    if (data.version !== 1) {
      console.warn(`[cron-context] Unsupported cron store version: ${data.version}`);
      return null;
    }
    return data;
  } catch (err) {
    console.error("[cron-context] Failed to read cron store:", err);
    return null;
  }
}

/**
 * Extract cron job ID from session key
 * Format: agent:<agentId>:cron:<jobId>:run:<runId>
 */
function extractCronJobId(sessionKey: string): string | null {
  const match = sessionKey.match(/:cron:([^:]+):run:/);
  return match ? match[1] : null;
}

/**
 * Extract the last assistant text from messages array
 */
function extractLastAssistantText(messages: unknown[]): string | null {
  // Walk backwards to find last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "assistant") continue;

    // Handle string content
    if (typeof msg.content === "string") return msg.content;

    // Handle array content (multi-part messages)
    if (Array.isArray(msg.content)) {
      const textParts = (msg.content as Record<string, unknown>[])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  return null;
}

/**
 * Construct target session key from cron delivery config
 */
function buildTargetSessionKey(
  agentId: string,
  delivery: CronJob["delivery"]
): string | null {
  if (!delivery?.channel || !delivery?.to) return null;
  // delivery.to is like "channel:1491644155451932934" or "user:123"
  return `agent:${agentId}:${delivery.channel}:${delivery.to}`;
}

export default function register(api: any) {
  const config: CronContextConfig =
    api.config?.plugins?.entries?.["cron-context"]?.config ?? {};
  const includePatterns = config.include ?? ["*"];
  const excludePatterns = config.exclude ?? [];
  const maxLength = config.maxLength ?? 4000;
  const maxEventsPerSession = config.maxEventsPerSession ?? 5;
  const prefixTemplate = config.prefix ?? "[Cron output from {cronName}]";

  // Track event counts per target session to cap accumulation
  const eventCounts = new Map<string, number>();

  // Resolve openclaw dir (parent of workspace)
  const openclawDir = join(api.config?.workspaceDir ?? process.env.HOME + "/.openclaw/workspace", "..");

  api.on(
    "agent_end",
    async (
      event: { messages: unknown[]; success: boolean },
      ctx: {
        agentId?: string;
        sessionKey?: string;
        workspaceDir?: string;
        trigger?: string;
      }
    ) => {
      // Only process cron-triggered runs
      if (ctx.trigger !== "cron") return;

      // Skip failed runs
      if (!event.success) return;

      // Need session key to extract job ID
      if (!ctx.sessionKey) return;

      // Extract cron job ID from session key
      const cronJobId = extractCronJobId(ctx.sessionKey);
      if (!cronJobId) {
        console.warn("[cron-context] Could not extract cron job ID from:", ctx.sessionKey);
        return;
      }

      // Load cron store and find the job
      const store = loadCronJobs(openclawDir);
      if (!store) return;

      const job = store.jobs.find((j) => j.id === cronJobId);
      if (!job) {
        console.warn("[cron-context] Cron job not found:", cronJobId);
        return;
      }

      // Check include/exclude patterns
      const included = includePatterns.some((p) => matchGlob(p, job.name));
      const excluded = excludePatterns.some((p) => matchGlob(p, job.name));
      if (!included || excluded) return;

      // Skip jobs with no delivery target
      if (!job.delivery || job.delivery.mode === "none") return;

      // Only process isolated sessions (main sessions already have context)
      if (job.sessionTarget !== "isolated") return;

      // Build target session key
      const agentId = ctx.agentId ?? "kagura";
      const targetSessionKey = buildTargetSessionKey(agentId, job.delivery);
      if (!targetSessionKey) {
        console.warn("[cron-context] Could not build target session key for job:", job.name);
        return;
      }

      // Extract last assistant message
      const lastText = extractLastAssistantText(event.messages ?? []);
      if (!lastText || lastText.trim() === "NO_REPLY") return;

      // Truncate if needed
      let text = lastText;
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + "\n... [truncated]";
      }

      // Add prefix
      const prefix = prefixTemplate.replace("{cronName}", job.name);
      const fullText = `${prefix}\n\n${text}`;

      // Check event cap for this target session
      const currentCount = eventCounts.get(targetSessionKey) ?? 0;
      if (currentCount >= maxEventsPerSession) {
        console.log(
          `[cron-context] Skipping "${job.name}" — target session ${targetSessionKey} already has ${currentCount} pending events (cap: ${maxEventsPerSession})`
        );
        return;
      }

      // Inject into target session
      try {
        if (api.runtime?.system?.enqueueSystemEvent) {
          const result = api.runtime.system.enqueueSystemEvent(fullText, {
            sessionKey: targetSessionKey,
            contextKey: `cron-context:${cronJobId}:${Date.now()}`,
          });
          if (result) {
            eventCounts.set(targetSessionKey, currentCount + 1);
          }
          console.log(
            `[cron-context] Injected output from "${job.name}" into ${targetSessionKey} (${result ? "ok" : "skipped"}, pending: ${(eventCounts.get(targetSessionKey) ?? 0)}/${maxEventsPerSession})`
          );
        } else {
          console.warn("[cron-context] enqueueSystemEvent not available in runtime");
        }
      } catch (err) {
        console.error("[cron-context] Failed to inject:", err);
      }
    },
    { priority: -20 } // Low priority — run after other hooks
  );

  // Reset event counts when target session drains its events (session activated)
  // We hook into the system event consumption indirectly — when a new cron injects
  // and the count was at max, we check if events were drained since last check
  // For simplicity, we reset counts periodically (every hour)
  setInterval(() => {
    eventCounts.clear();
  }, 60 * 60 * 1000);

  console.log(
    `[cron-context] Plugin loaded (include=${includePatterns.join(",")}, exclude=${excludePatterns.join(",")}, maxLength=${maxLength}, maxEventsPerSession=${maxEventsPerSession})`
  );
}
