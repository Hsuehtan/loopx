import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnDelta, Usage } from "./types.ts";

/**
 * The Codex adapter — the one non-trivial piece of real engineering here.
 *
 * It shells out to `codex exec` and drives continuation with `resume <thread_id>`.
 * The three facts it relies on are verified against the installed CLI:
 *   - `--json` emits a JSONL event stream (`thread.started`, `turn.completed`);
 *   - `resume <SESSION_ID>` continues the same thread, so the model keeps its
 *     own working context and the kernel does not have to replay history;
 *   - `--output-schema` makes the final message a validated JSON object.
 *
 * A production rewrite would speak the app-server RPC protocol directly for
 * streaming and interrupt control. A subprocess per turn is the honest minimum
 * that is still real: it is the actual Codex runtime, not a mock.
 */
export interface CodexTurnRequest {
  projectRoot: string;
  prompt: string;
  /** null starts a new thread; otherwise the kernel resumes this session. */
  sessionId: string | null;
  model?: string;
  /**
   * Codex sandbox for the turn. The kernel defaults to `workspace-write` because
   * a goal that cannot change the workspace can never satisfy a file predicate;
   * `read-only` is available for inspection-only goals and is the safer choice
   * when the objective is analysis rather than delivery.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
}

export interface CodexTurnResult {
  delta: TurnDelta;
  sessionId: string | null;
  sessionReused: boolean;
  usage: Usage;
  durationMs: number;
}

/** Mirrors `TurnDelta` in types.ts. A smoke test asserts the two agree. */
export function deltaJsonSchema(): Record<string, unknown> {
  const assumption = {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "source"],
    properties: {
      id: { type: "string", minLength: 1 },
      statement: { type: "string", minLength: 1 },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "sha256"],
        properties: {
          kind: { type: "string", enum: ["file"] },
          path: { type: "string", minLength: 1 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
  } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: ["closed", "new_todos", "new_assumptions", "proposed_amendment", "note"],
    properties: {
      closed: { type: "array", items: { type: "string" } },
      new_todos: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "done_when", "advances"],
          properties: {
            id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            done_when: { type: "string", minLength: 1 },
            advances: { type: "string", minLength: 1 },
          },
        },
      },
      new_assumptions: { type: "array", items: assumption },
      proposed_amendment: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["objective", "reason"],
            properties: {
              objective: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
        ],
      },
      note: { type: "string" },
    },
  };
}

export async function runCodexTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
  const started = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "goal-kernel-"));
  const schemaPath = join(scratch, "delta.schema.json");
  const lastMessagePath = join(scratch, "last-message.json");
  writeFileSync(schemaPath, JSON.stringify(deltaJsonSchema()), "utf8");

  const args = buildArgs(request, schemaPath, lastMessagePath);
  const { stdout, stderr, code } = await run("codex", args, request.projectRoot, request.timeoutMs ?? 30 * 60_000);

  const events = parseEvents(stdout);
  const sessionId = events.sessionId;
  const usage = events.usage;

  if (!events.completed) {
    const tail = stderr.trim().slice(-800);
    throw new Error(
      `codex turn did not complete (exit ${code}): ${events.error ?? (tail || "no event stream")}`,
    );
  }

  const raw = readLastMessage(lastMessagePath, events.finalMessage);
  const delta = parseDelta(raw);
  return {
    delta,
    sessionId,
    sessionReused: request.sessionId !== null && sessionId === request.sessionId,
    usage,
    durationMs: Date.now() - started,
  };
}

function buildArgs(
  request: CodexTurnRequest,
  schemaPath: string,
  lastMessagePath: string,
): string[] {
  const common = [
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "--skip-git-repo-check",
  ];
  // Use a config override accepted by both exec and resume, on every turn.
  const sandbox = [`-c`, `sandbox_mode=${JSON.stringify(request.sandbox ?? "workspace-write")}`];
  const model = request.model ? ["--model", request.model] : [];
  if (request.sessionId) {
    return ["exec", "resume", ...common, ...sandbox, ...model, request.sessionId, request.prompt];
  }
  return ["exec", ...common, ...sandbox, ...model, request.prompt];
}

interface ParsedEvents {
  sessionId: string | null;
  usage: Usage;
  completed: boolean;
  finalMessage: string | null;
  error: string | null;
}

function parseEvents(stdout: string): ParsedEvents {
  const out: ParsedEvents = {
    sessionId: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    completed: false,
    finalMessage: null,
    error: null,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "thread.started" && typeof event.thread_id === "string") {
      out.sessionId = event.thread_id;
    } else if (type === "turn.completed" && event.usage) {
      out.completed = true;
      const usage = event.usage as Record<string, number>;
      out.usage = {
        input_tokens: usage.input_tokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      };
    } else if (type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        out.finalMessage = item.text;
      }
    } else if (type === "error" || type === "turn.failed") {
      out.error = typeof event.message === "string" ? event.message : JSON.stringify(event);
    }
  }
  return out;
}

function readLastMessage(path: string, fallback: string | null): string {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text !== "") return text;
  } catch {
    // Fall through to the streamed agent message.
  }
  if (fallback !== null) return fallback;
  throw new Error("codex returned no final message");
}

/** Tolerate a fenced or slightly annotated response, but never invent a delta. */
export function parseDelta(raw: string): TurnDelta {
  const text = stripFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`turn did not return a JSON delta: ${text.slice(0, 300)}`);
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  const value = parsed as Partial<TurnDelta>;
  if (value === null || typeof value !== "object") {
    throw new Error("turn delta was not an object");
  }
  return {
    closed: Array.isArray(value.closed) ? value.closed.filter(isString) : [],
    new_todos: Array.isArray(value.new_todos) ? value.new_todos : [],
    new_assumptions: Array.isArray(value.new_assumptions) ? value.new_assumptions : [],
    proposed_amendment: value.proposed_amendment ?? null,
    note: typeof value.note === "string" ? value.note : "",
  };
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(text);
  return match ? match[1].trim() : text;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex turn exceeded ${timeoutMs}ms and was killed`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
