import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_PROVIDER = "openai-codex";

type ExtensionDiagnostic = {
  type: "error";
  code: "auth-failed" | "missing-openai-codex-auth";
  message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; diagnostic: ExtensionDiagnostic };
type AuthStorageInstance = ReturnType<typeof AuthStorage.create>;
type OpenAICodexApi = typeof OPENAI_CODEX_API;

type FastState = {
  enabled: boolean;
};

const FAST_STATE_PATH = join(getAgentDir(), "codex-fast.json");

function isCodexProvider(provider: string | undefined): boolean {
  return provider === OPENAI_CODEX_PROVIDER;
}

async function readFastState(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(FAST_STATE_PATH, "utf8")) as Partial<FastState>;
    return parsed.enabled === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[codex-fast-toggle] Failed to read ${FAST_STATE_PATH}:`, error);
    }
    return true;
  }
}

async function writeFastState(enabled: boolean): Promise<void> {
  await mkdir(dirname(FAST_STATE_PATH), { recursive: true });
  const temporaryPath = `${FAST_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, FAST_STATE_PATH);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function createFastAutocompleteProvider(
  current: AutocompleteProvider,
  isAvailable: () => boolean,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "/"])],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (!isAvailable()) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const currentLine = lines[cursorLine] ?? "";
      const beforeCursor = currentLine.slice(0, cursorCol);
      const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
      if (commandMatch) {
        const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const query = commandMatch[1].toLowerCase();
        if (!"fast".startsWith(query)) {
          return base;
        }
        const fastItem = {
          value: "fast",
          label: "fast",
          description: "Toggle OpenAI Codex priority service tier",
        };
        return {
          prefix: beforeCursor,
          items: [fastItem, ...(base?.items.filter((item) => item.value !== "fast") ?? [])],
        };
      }

      const argumentMatch = beforeCursor.match(/^\/fast\s+([^\s]*)$/);
      if (argumentMatch) {
        const query = argumentMatch[1].toLowerCase();
        const items = [
          { value: "on", label: "on", description: "Use priority service tier" },
          { value: "off", label: "off", description: "Use default service tier" },
        ].filter((item) => item.value.startsWith(query));
        return items.length > 0 ? { items, prefix: argumentMatch[1] } : null;
      }

      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function authFailedDiagnostic(reason: string): ExtensionDiagnostic {
  return {
    type: "error",
    code: "auth-failed",
    message: `${OPENAI_CODEX_PROVIDER} auth failed: ${reason}`,
  };
}

async function getOpenAICodexAuth(authStorage: AuthStorageInstance): Promise<Result<string>> {
  try {
    authStorage.drainErrors();
    authStorage.reload();
    const authErrors = authStorage.drainErrors();

    const apiKey = await authStorage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
    authErrors.push(...authStorage.drainErrors());

    if (apiKey) {
      return { ok: true, value: apiKey };
    }

    if (authErrors.length > 0) {
      return {
        ok: false,
        diagnostic: authFailedDiagnostic(authErrors.map((error) => error.message).join("; ")),
      };
    }

    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "missing-openai-codex-auth",
        message: `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: authFailedDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

function endWithCanonicalError(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  modelId: string,
  errorMessage: string,
  options?: SimpleStreamOptions,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options?.signal?.aborted ? "aborted" : "error",
    errorMessage,
    timestamp: Date.now(),
  };
  stream.push({
    type: "error",
    reason: message.stopReason === "aborted" ? "aborted" : "error",
    error: message,
  });
  stream.end(message);
}

function streamSimpleOpenAICodexToggle(
  authStorage: AuthStorageInstance,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  isFastEnabled: () => boolean,
) {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    try {
      const codexModel = model as Model<OpenAICodexApi>;
      const auth = await getOpenAICodexAuth(authStorage);
      if (!auth.ok) {
        endWithCanonicalError(outer, model.id, auth.diagnostic.message, options);
        return;
      }

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(codexModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const inner = streamOpenAICodexResponses(codexModel, context, {
        ...options,
        apiKey: auth.value,
        ...(isFastEnabled() ? { serviceTier: "priority" as const } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      for await (const event of inner) {
        outer.push(event);
      }
      outer.end();
    } catch (error) {
      endWithCanonicalError(
        outer,
        model.id,
        error instanceof Error ? error.message : String(error),
        options,
      );
    }
  })();

  return outer;
}

export default async function (pi: ExtensionAPI) {
  const authStorage = AuthStorage.create();
  let fastEnabled = await readFastState();

  pi.registerProvider(OPENAI_CODEX_PROVIDER, {
    api: OPENAI_CODEX_API,
    streamSimple: (model, context, options) =>
      streamSimpleOpenAICodexToggle(authStorage, model, context, options, () => fastEnabled),
  });

  function updateStatus(ctx: ExtensionContext): void {
    const showFast = fastEnabled && isCodexProvider(ctx.model?.provider);
    ctx.ui.setStatus("codex-fast", showFast ? ctx.ui.theme.fg("accent", "⚡ fast") : undefined);
  }

  async function refreshState(ctx: ExtensionContext): Promise<void> {
    fastEnabled = await readFastState();
    updateStatus(ctx);
  }

  async function setFastMode(enabled: boolean, ctx: ExtensionContext): Promise<void> {
    fastEnabled = enabled;
    await writeFastState(enabled);
    updateStatus(ctx);
    ctx.ui.notify(`Codex Fast: ${enabled ? "On (priority)" : "Off (default)"}`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) =>
      createFastAutocompleteProvider(current, () => isCodexProvider(ctx.model?.provider)),
    );
    await refreshState(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refreshState(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await refreshState(ctx);
  });

  pi.on("input", async (event, ctx) => {
    const match = event.text.trim().match(/^\/fast(?:\s+(\S+))?$/i);
    if (!match) {
      return { action: "continue" as const };
    }

    if (!isCodexProvider(ctx.model?.provider)) {
      ctx.ui.notify("/fast is only available for OpenAI Codex models", "warning");
      return { action: "handled" as const };
    }

    let requested = match[1]?.toLowerCase();
    if (!requested) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /fast on|off", "error");
        return { action: "handled" as const };
      }
      const selection = await ctx.ui.select("Codex Fast", [
        "On — priority service tier",
        "Off — default service tier",
      ]);
      if (!selection) {
        return { action: "handled" as const };
      }
      requested = selection.startsWith("On") ? "on" : "off";
    }

    if (requested !== "on" && requested !== "off") {
      ctx.ui.notify("Usage: /fast on|off", "error");
      return { action: "handled" as const };
    }

    await setFastMode(requested === "on", ctx);
    return { action: "handled" as const };
  });
}
