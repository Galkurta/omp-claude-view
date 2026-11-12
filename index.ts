// Claude Code look for omp, as one package, built from Claude Code 2.1.322's own renderers:
// claude-dark/claude-light themes; the bottom-anchored prompt with `Try "…"` placeholder,
// status line + permission-mode footer and the ponytail band; `● Tool(arg)` / `⎿  summary`
// tool rows with diff backgrounds, collapsed read/search runs and agent/search/fetch
// summaries; `❯` prompts, `●` replies, `✻ Thinking…`; the `✻ Verb… (12s · ↓ tokens)` spinner
// and `✻ Worked for Ns`; the permission dialog and the `/config`-style settings screen
// (settings.ts). Runtime setting overrides only, never written to config.yml. Display only:
// the session and model context are unchanged; Ctrl+O still shows omp's full cards.
// Component patches live in patches.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, theme, VERSION } from "@oh-my-pi/pi-coding-agent";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { openSettings } from "./settings.ts";
import { ANCHOR, approvals, cc, ccColors, dropLeadingChar, hookStatuses, plain, diffRows as markedDiffRows, headerInfo, installPatches, placeholder, presenters, setTurnVerb, settingsUi, turn } from "./patches.ts";

type Span = { t: string; s?: string };
type Text = string | Span[];
type Task = { content: string; status: string };
type SubTool = { tool?: string; args?: string };
type Agent = {
	id?: string;
	agent?: string;
	description?: string;
	status?: string;
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	currentTool?: string;
	currentToolArgs?: string;
	recentTools?: SubTool[]; // newest first
};
type Details = {
	displayContent?: { lineNumbers?: number[] };
	diff?: unknown;
	path?: string;
	fileCount?: number;
	files?: string[];
	phases?: Array<{ tasks?: Task[] }>;
	kind?: string;
	progress?: Agent[];
	async?: { state?: string };
	xdev?: { tool?: string };
};
// Shape of the `toolCall` TranscriptBlock omp passes to presenters.
type Block = {
	type: string;
	id: string;
	toolName?: string;
	args?: Record<string, unknown>;
	result?: { content?: Array<{ type: string; text?: string }>; details?: Details };
	isError?: boolean;
	isPartial?: boolean;
};

/** Calls waiting on a permission dialog. */
const awaiting = new Set<string>();
/** Wall time per tool call, from tool_execution_start/end (Claude's "in 3s"). */
const durations = new Map<string, number>();

const PREVIEW_ROWS = 3;
const DIFF_ROWS = 10;
const WRITE_ROWS = 10;
const MAX_ARG = 90;
const MAX_LINE = 200;
const EXPAND = "(ctrl+o to expand)";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: unknown) => clip(String(s ?? "").split(/\r?\n/)[0].trim(), MAX_ARG);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const lines = (s: string) => s.replace(/\s+$/, "").split(/\r?\n/).filter((l, i, a) => l !== "" || i < a.length - 1);

function resultText(b: Block): string {
	return (b.result?.content ?? [])
		.filter(c => c.type === "text" && c.text)
		.map(c => c.text!)
		.join("\n");
}

// Hashline edit/write targets look like `[path#TAG]`.
function hashlinePaths(input: unknown): string[] {
	return [...String(input ?? "").matchAll(/^\[(.+?)#[0-9A-Fa-f]{4}\]\s*$/gm)].map(m => m[1]);
}

const isUrl = (p: unknown) => typeof p === "string" && /^https?:\/\//i.test(p);
// omp reaches MCP and other devices through `read`/`write` on `xd://<tool>`.
const XD_MCP = /^xd:\/\/mcp__(.+?)_(?:_)?(.+)$/;

function title(b: Block): [string, string | undefined] {
	const a = b.args ?? {};
	const n = b.toolName ?? "tool";
	const mcp = (n === "write" || n === "read") && typeof a.path === "string" ? mcpName(a.path) : undefined;
	if (mcp) return [`${mcp} (MCP)`, n === "write" ? oneLine(a.content) : undefined];
	switch (n) {
		case "read":
			return [isUrl(a.path) ? "Fetch" : "Read", oneLine(isUrl(a.path) ? a.path : relative(String(a.path ?? "")))];
		case "fetch":
		case "web_fetch":
			return ["Fetch", oneLine(a.url ?? a.path)];
		case "bash":
			return ["Bash", oneLine(a.command)];
		case "edit":
		case "ast_edit":
			return ["Update", oneLine(relative(hashlinePaths(a.input).join(", ") || String(a.path ?? "")))];
		case "write":
			return ["Write", oneLine(relative(String(a.path ?? "")))];
		case "grep":
			return ["Search", `pattern: "${oneLine(a.pattern)}"${a.path ? `, path: "${oneLine(relative(String(a.path)) || ".")}"` : ""}`];
		case "glob":
			return ["Search", `pattern: "${oneLine(relative(String(a.path ?? a.pattern)) || ".")}"`];
		case "ast_grep":
			return ["Search", `pattern: "${oneLine(a.pattern ?? a.pat)}"`];
		case "todo":
			return ["Update Todos", undefined];
		case "task": {
			const tasks = Array.isArray(a.tasks) ? a.tasks : [];
			// Claude Code: `Explore(<description>)`.
			const names = tasks.map((t: { name?: string; agent?: string; description?: string }) => t.description ?? t.name ?? t.agent ?? "agent");
			return [tasks.length === 1 && typeof tasks[0]?.agent === "string" ? capital(tasks[0].agent) : "Task", oneLine(names.join(", ") || a.context)];
		}
		case "web_search":
			return ["Web Search", `"${oneLine(a.query)}"`];
		case "eval":
			return [a.language === "js" ? "JavaScript" : "Python", oneLine(a.code)];
		case "lsp":
			return ["LSP", oneLine(a.action ?? a.operation)];
		case "ask":
			return ["AskUserQuestion", undefined];
		case "wait":
			return ["Wait", undefined];
	}
	const native = /^mcp__(.+?)__(.+)$/.exec(n);
	if (native) return [`${native[1]} - ${native[2]} (MCP)`, firstArg(a)];
	return [capital(n), firstArg(a)];
}

function capital(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

// `xd://mcp__bug_bounties_get_stats` → "bug_bounties - get_stats". Device names join server and
// tool with `_`, so split before the first verb-like segment when unambiguous.
function mcpName(path: string): string | undefined {
	const m = /^xd:\/\/mcp__([a-z0-9-]+?(?:_[a-z0-9-]+)*?)_((?:get|list|search|lookup|create|update|delete|execute|apply|ctx|open|close|read|write|set|inspect|run|query|deploy|fetch)(?:_.*)?|[^_]+)$/i.exec(path);
	return m ? `${m[1]} - ${m[2]}` : XD_MCP.test(path) ? path.slice("xd://mcp__".length) : undefined;
}

function firstArg(a: Record<string, unknown>): string | undefined {
	for (const [k, v] of Object.entries(a)) {
		if (k === "i" || k.startsWith("__")) continue;
		if (typeof v === "string" && v.trim()) return oneLine(v);
	}
	return undefined;
}

// Claude Code: the first 3 output lines (4 when only one would be hidden), then
// `… +N lines (ctrl+o to expand)`.
function preview(text: string, empty = "(No content)"): Text[] {
	const all = lines(text);
	if (all.length === 0) return [[{ t: empty, s: "dim" }]];
	const keep = all.length === PREVIEW_ROWS + 1 ? all.length : PREVIEW_ROWS;
	const rows: Text[] = all.slice(0, keep).map(l => clip(l, MAX_LINE));
	if (all.length > keep) rows.push([{ t: `… +${plural(all.length - keep, "line")} ${EXPAND}`, s: "dim" }]);
	return rows;
}

// "Found N files" with N bold; " (ctrl+o to expand)" when something was found.
function found(n: number, noun: string): Text {
	return [{ t: "Found " }, { t: String(n), s: "strong" }, { t: ` ${n === 1 ? noun : `${noun}s`}` }, ...(n > 0 ? [{ t: ` ${EXPAND}`, s: "dim" }] : [])];
}

// omp diff rows look like ` 1|text`, `-2|text`, `+2|text`; Claude Code draws `2 -text` on a
// red/green line background with the changed words highlighted.
function diffRows(diff: string): Text[] {
	const all = lines(diff).map(l => {
		const m = /^([ +-])\s*(\d*)\|(.*)$/.exec(l);
		return m ? { sign: m[1], num: m[2], text: m[3] } : { sign: " ", num: "", text: l };
	});
	const rows: Text[] = markedDiffRows(all.slice(0, DIFF_ROWS));
	if (all.length > DIFF_ROWS) rows.push([{ t: `… +${plural(all.length - DIFF_ROWS, "line")} ${EXPAND}`, s: "dim" }]);
	return rows;
}

function seconds(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Claude Code's agent rows: `Done (12 tool uses · 30.1k tokens · 1m 2s)  (ctrl+o to expand)`;
// while it runs, its last 3 sub-tool calls and `… +N tool uses (ctrl+o to expand)`;
// `Initializing…` before its first tool.
const AGENT_TOOLS = 3;
const resolved = (p: Agent) => p.status === "completed" || p.status === "failed" || p.status === "aborted";

/** The agent's sub-tool calls, oldest first: finished ones, then the running one. */
function subTools(p: Agent): SubTool[] {
	const done = [...(p.recentTools ?? [])].reverse();
	return p.currentTool ? [...done, { tool: p.currentTool, args: p.currentToolArgs }] : done;
}

// Claude Code shows paths relative to the working directory.
const relative = (s: string) => {
	const cwd = process.cwd();
	return s.split(cwd).join(".").split(cwd.replaceAll("\\", "/")).join(".").replace(/(^|[\s"'(])\.[\\/]/g, "$1");
};

const toolName = (tool: string | undefined) => title({ type: "toolCall", id: "", toolName: tool ?? "tool", args: {} })[0];

function agentRows(p: Agent): Text[] {
	if (!resolved(p)) {
		const calls = subTools(p).slice(-AGENT_TOOLS);
		if (!calls.length) return [[{ t: "Initializing…", s: "dim" }]];
		const rows: Text[] = calls.map(c => [{ t: toolName(c.tool), s: "strong" }, ...(c.args ? [{ t: `(${clip(relative(c.args), MAX_ARG)})` }] : [])]);
		const hidden = (p.toolCount ?? 0) - calls.length;
		if (hidden > 0) rows.push([{ t: `… +${plural(hidden, "tool use")} ${EXPAND}`, s: "dim" }]);
		return rows;
	}
	const parts = [plural(p.toolCount ?? 0, "tool use")];
	if (p.tokens) parts.push(`${kTokens(p.tokens)} tokens`);
	if (p.durationMs) parts.push(seconds(p.durationMs));
	return [[{ t: `${p.status === "completed" ? "Done" : "Failed"} (${parts.join(" · ")})`, s: p.status === "completed" ? undefined : "error" }, { t: `  ${EXPAND}`, s: "dim" }]];
}

// Claude Code's last-activity line for one agent of a group: `Bash: npm test`, or a summary
// when it ended on 2+ reads/searches (`Searching for 2 patterns, reading 1 file…`).
function lastActivity(p: Agent): string | undefined {
	const calls = subTools(p);
	const tail: Block[] = [];
	for (let i = calls.length - 1; i >= 0 && kindOf(calls[i].tool, { path: calls[i].args }); i--)
		tail.push({ type: "toolCall", id: "", toolName: calls[i].tool, args: { path: calls[i].args }, isPartial: true });
	if (tail.length >= 2) return labelFor(tail).slice(0, -1).map(s => s.t).join("");
	const last = calls.at(-1);
	if (!last) return undefined;
	return last.args ? `${toolName(last.tool)}: ${clip(relative(last.args), 60)}` : toolName(last.tool);
}

// Claude Code draws parallel agents as one group:
//   ● Running 3 Explore agents… (ctrl+o to expand)
//      ├─ Find auth code · 4 tool uses · 12.3k tokens
//      │  ⎿  Search: "token"
//      └─ …
//         ⎿  Done
function agentGroup(agents: Agent[], background: boolean) {
	const running = !background && agents.some(p => !resolved(p));
	const types = new Set(agents.map(p => p.agent ?? "task"));
	const one = types.size === 1 ? [...types][0] : undefined;
	const noun = one && one !== "task" ? `${capital(one)} agents` : "agents";
	const n = { t: String(agents.length), s: "strong" };
	// Background agents: `3 background agents launched`, one name row each.
	const label: Span[] = background ? [n, { t: " background agents launched" }] : running ? [{ t: "Running " }, n, { t: ` ${noun}…` }] : [n, { t: ` ${noun} finished` }];
	if (!background) label.push({ t: ` ${EXPAND}`, s: "dim" });
	const rows: Text[] = agents.flatMap((p, i): Text[] => {
		const last = i === agents.length - 1;
		const dim = resolved(p) || background ? undefined : "dim";
		const desc = p.description ?? p.id;
		const name: Span[] = one
			? [{ t: desc ?? capital(p.agent ?? "agent"), s: dim ? "strong dim" : "strong" }]
			: [{ t: capital(p.agent ?? "agent"), s: dim ? "strong dim" : "strong" }, ...(desc ? [{ t: ` (${desc})`, s: dim }] : [])];
		const stats = ` · ${plural(p.toolCount ?? 0, "tool use")}${p.tokens ? ` · ${kTokens(p.tokens)} tokens` : ""}`;
		const status = resolved(p) ? (p.status === "completed" ? "Done" : "Failed") : lastActivity(p) ?? "Initializing…";
		const head: Text = [{ t: ` ${last ? "└─" : "├─"} `, s: "dim" }, ...name, ...(background ? [] : [{ t: stats, s: dim }])];
		if (background) return [head];
		return [
			head,
			[{ t: ` ${last ? " " : "│"}  ⎿  `, s: "dim" }, { t: status, s: p.status === "failed" ? "error" : "dim" }],
		];
	});
	return { compact: { label, rows } };
}

/** A finished task call whose agents run on as background jobs. */
const launched = (b: Block) => !b.isPartial && !!b.result && !!b.result.details?.async;

/** One entry per agent of a task call: its progress, else what the call's arguments say. */
function agentsOf(b: Block): Agent[] {
	const progress = b.result?.details?.progress ?? [];
	const items = Array.isArray(b.args?.tasks) ? (b.args.tasks as Array<{ name?: string; agent?: string; description?: string }>) : [];
	const n = Math.max(progress.length, items.length);
	return Array.from({ length: n }, (_, i) => ({ id: items[i]?.name, agent: items[i]?.agent, description: items[i]?.description, status: b.isPartial || !b.result ? "pending" : b.isError ? "failed" : "completed", ...progress[i] }));
}

// Claude Code's rows for a tool the user interrupted or rejected.
const INTERRUPTED: Text = [{ t: "Interrupted ", s: "dim" }, { t: "· What should omp do instead?", s: "dim" }];
const ERROR_ROWS = 10;

function body(b: Block): Text[] {
	const d = b.result?.details ?? {};
	if (b.toolName === "task" && launched(b)) return [[{ t: "Backgrounded agent" }, { t: ` ${EXPAND}`, s: "dim" }]];
	if (b.toolName === "task" && d.progress?.length) return agentRows(d.progress[0]);
	if (b.toolName === "task" && (b.isPartial || !b.result)) return [[{ t: "Initializing…", s: "dim" }]];
	if ((b.isPartial || !b.result) && awaiting.has(b.id)) return [[{ t: "Waiting for permission…", s: "dim" }]];
	if (b.isPartial || !b.result) return [[{ t: b.toolName === "bash" ? "Running…" : b.toolName === "read" && isUrl(b.args?.path) ? "Fetching…" : "Waiting…", s: "dim" }]];
	const text = resultText(b);
	if (b.isError) {
		if (/\b(interrupted|aborted|cancelled by user|rejected|denied by user)\b/i.test(text.slice(0, 200))) return [INTERRUPTED];
		// Claude Code: `Error: …` in red, at most 10 lines. A failed command reads
		// `Error: Exit code N` with the output below it.
		const exit = b.toolName === "bash" ? /\n*Command exited with code (\d+)\s*$/.exec(text) : null;
		const all = exit ? [`Exit code ${exit[1]}`, ...lines(text.slice(0, exit.index))] : lines(text);
		const first = all[0] ?? "failed";
		const rows: Text[] = [[{ t: clip(/^(Error|Cancelled): /.test(first) ? first : `Error: ${first}`, MAX_LINE), s: "error" }]];
		for (const l of all.slice(1, ERROR_ROWS)) rows.push([{ t: clip(l, MAX_LINE), s: "error" }]);
		if (all.length > ERROR_ROWS) rows.push([{ t: `… +${plural(all.length - ERROR_ROWS, "line")} ${EXPAND}`, s: "dim" }]);
		return rows;
	}
	if (d.xdev) return preview(text);
	switch (b.toolName) {
		case "read": {
			if (d.kind === "url") return [[{ t: "Received " }, { t: `${(Buffer.byteLength(text) / 1024).toFixed(1)}KB`, s: "strong" }]];
			const n = d.displayContent?.lineNumbers?.length ?? Math.max(lines(text).length - 1, 0);
			return [[{ t: "Read " }, { t: String(n), s: "strong" }, { t: n === 1 ? " line" : " lines" }]];
		}
		case "web_search": {
			const took = durations.get(b.id);
			return [`Did 1 search${took ? ` in ${seconds(took)}` : ""}`];
		}
		case "edit":
		case "ast_edit": {
			if (typeof d.diff !== "string") return preview(text);
			const dl = lines(d.diff);
			const add = dl.filter(l => l.startsWith("+")).length;
			const del = dl.filter(l => l.startsWith("-")).length;
			// Claude Code: "Added N lines, removed M lines".
			const head: Span[] = [];
			if (add) head.push({ t: "Added " }, { t: String(add), s: "strong" }, { t: add === 1 ? " line" : " lines" });
			if (add && del) head.push({ t: ", " });
			if (del) head.push({ t: add ? "removed " : "Removed " }, { t: String(del), s: "strong" }, { t: del === 1 ? " line" : " lines" });
			return [head.length ? head : "No changes", ...diffRows(d.diff)];
		}
		case "write": {
			// Claude Code: the summary, then the first 10 lines with line numbers, then
			// `… +N lines (~K KB) (ctrl+o to expand)`.
			const raw = String(b.args?.content ?? "");
			const content = lines(raw);
			const n = content.length;
			const width = String(Math.min(n, WRITE_ROWS)).length;
			const rows: Text[] = [[{ t: "Wrote " }, { t: String(n), s: "strong" }, { t: n === 1 ? " line to " : " lines to " }, { t: String(b.args?.path ?? "file"), s: "strong" }]];
			content.slice(0, WRITE_ROWS).forEach((l, i) => rows.push([{ t: `${String(i + 1).padStart(width)} `, s: "dim" }, { t: clip(l.replace(/\t/g, "    "), MAX_LINE) }]));
			if (n > WRITE_ROWS) rows.push([{ t: `… +${plural(n - WRITE_ROWS, "line")} (~${Math.max(1, Math.round(Buffer.byteLength(raw) / 1024))} KB) ${EXPAND}`, s: "dim" }]);
			return rows;
		}
		case "glob":
			return [found(d.fileCount ?? d.files?.length ?? lines(text).length, "file")];
		case "grep":
		case "ast_grep":
			return [found(lines(text).filter(l => l && !l.startsWith("#")).length, "line")];
		case "bash": {
			// omp appends run metadata Claude Code doesn't show; an empty run is `(No output)`.
			const out = lines(text)
				.filter(l => !/^(Wall time: |Ran in a copy of |Command exited with code )/.test(l))
				.join("\n")
				.replace(/^\(no output(, exit code 0)?\)\s*$/i, "")
				.trim();
			return preview(out, "(No output)");
		}
		case "todo": {
			const tasks = (d.phases ?? []).flatMap(p => p.tasks ?? []);
			if (!tasks.length) return preview(text);
			return tasks.map((t): Text =>
				t.status === "completed"
					? [{ t: `☒ ${t.content}`, s: "dim" }]
					: t.status === "in_progress"
						? [{ t: `☐ ${t.content}`, s: "strong" }]
						: `☐ ${t.content}`,
			);
		}
		case "wait": {
			// omp lists settled jobs as `### <id> [kind] — <status>` under markdown headings.
			const jobs = [...text.matchAll(/^###\s+(\S+).*?—\s*(\w+)/gm)].map(m => `${m[1]} ${m[2]}`);
			return jobs.length ? jobs : preview(text.replace(/^#+\s*/gm, ""));
		}
	}
	return preview(text);
}

// ── Collapsed runs: Claude Code folds consecutive read/search calls of one reply into
// "Read 2 files, searched for 1 pattern (ctrl+o to expand)"; the first call carries the
// summary, the rest are hidden.
type Kind = "read" | "search" | "list";
function kindOf(name: string | undefined, args: Record<string, unknown> | undefined): Kind | undefined {
	if (name === "read") return isUrl(args?.path) || String(args?.path ?? "").startsWith("xd://") ? undefined : "read";
	if (name === "grep" || name === "ast_grep" || name === "glob") return "search";
	if (name === "ls" || name === "find") return "list";
	return undefined;
}

const runs = new Map<string, string[]>(); // call id → ids of its run (shared array)
const seen = new Map<string, Block>(); // latest block per collapsible call

/** Rebuild runs from an assistant message's ordered tool calls; returns ids whose run changed. */
function indexRuns(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const changed: string[] = [];
	let current: string[] = [];
	const flush = () => {
		if (current.length >= 2) {
			const prev = runs.get(current[0]);
			if (!prev || prev.length !== current.length) changed.push(...current);
			for (const id of current) runs.set(id, current);
		}
		current = [];
	};
	for (const part of content) {
		if (!part || typeof part !== "object" || !("type" in part)) continue;
		if (part.type === "toolCall" && "id" in part && "name" in part && typeof part.id === "string") {
			const args = "arguments" in part && part.arguments && typeof part.arguments === "object" ? (part.arguments as Record<string, unknown>) : undefined;
			if (kindOf(String(part.name), args)) {
				current.push(part.id);
				continue;
			}
		}
		// Text between calls ends a run; empty text/thinking does not.
		if (part.type === "text" && "text" in part && typeof part.text === "string" && !part.text.trim()) continue;
		if (part.type === "thinking") continue;
		flush();
	}
	flush();
	return changed;
}

const RUN_VERBS: Record<Kind, [string, string, string, string]> = {
	read: ["Reading", "Read", "file", "files"],
	search: ["Searching for", "Searched for", "pattern", "patterns"],
	list: ["Listing", "Listed", "directory", "directories"],
};

function runLabel(ids: string[]): Span[] {
	return labelFor(ids.map(id => seen.get(id)));
}

function labelFor(blocks: Array<Block | undefined>): Span[] {
	const running = blocks.some(b => !b || b.isPartial || !b.result);
	const counts = new Map<Kind, number>();
	for (const b of blocks) {
		const k = b ? kindOf(b.toolName, b.args) : undefined;
		if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const out: Span[] = [];
	for (const [k, n] of counts) {
		const [ing, ed, one, many] = RUN_VERBS[k];
		const verb = running ? ing : ed;
		out.push({ t: out.length ? `, ${verb.toLowerCase()} ` : `${verb} ` }, { t: String(n), s: "strong" }, { t: ` ${n === 1 ? one : many}` });
	}
	out.push({ t: running ? "…" : "" }, { t: ` ${EXPAND}`, s: "dim" });
	return out;
}

// Plugins can't ship themes, so copy ours into the custom themes dir (only when changed,
// so omp's theme watcher picks up updates). ponytail: ignores named --profile dirs.
// The user's Claude Code theme: `"theme": "custom:<name>"` in ~/.claude/settings.json picks
// ~/.claude/themes/<name>.json, `{ base: "dark" | "light", overrides: { <key>: color } }`.
// Its overrides recolor our theme of the same base, so omp matches what Claude Code shows.
const THEME_VARS: Record<string, string> = {
	claude: "claude",
	claudeShimmer: "claudeShimmer",
	permission: "permission",
	planMode: "planMode",
	autoAccept: "autoAccept",
	bashBorder: "bash",
	ide: "ide",
	success: "success",
	error: "error",
	warning: "warning",
	text: "text",
	inactive: "secondary",
	subtle: "subtle",
	promptBorder: "border",
	userMessageBackground: "userMsgBg",
};

/** `#rrggbb` / `rgb(r, g, b)` → [r, g, b]; undefined for ANSI names and anything else. */
function parseColor(value: unknown): [number, number, number] | undefined {
	if (typeof value !== "string") return undefined;
	const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
	if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
	const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value.trim());
	return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function claudeTheme(dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): { base: "dark" | "light"; colors: Record<string, [number, number, number]> } | undefined {
	try {
		const name = /^custom:(.+)$/.exec(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).theme ?? "")?.[1];
		if (!name || /[\\/]/.test(name)) return undefined;
		const file = JSON.parse(readFileSync(join(dir, "themes", `${name}.json`), "utf8"));
		const colors: Record<string, [number, number, number]> = {};
		for (const [key, value] of Object.entries(file.overrides ?? {})) {
			const c = parseColor(value);
			if (c) colors[key] = c;
		}
		return { base: String(file.base ?? "dark").startsWith("light") ? "light" : "dark", colors };
	} catch {
		return undefined; // no settings, no custom theme, or unreadable: Claude Code's defaults
	}
}

function installThemes(pi: ExtensionAPI): void {
	const src = fileURLToPath(new URL("./themes/", import.meta.url));
	const dest = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "themes");
	const user = claudeTheme();
	if (user)
		for (const [key, [r, g, b]] of Object.entries(user.colors)) if (key in ccColors[user.base]) ccColors[user.base][key] = `${r};${g};${b}`;
	try {
		mkdirSync(dest, { recursive: true });
		for (const file of readdirSync(src)) {
			let body = readFileSync(join(src, file), "utf8");
			if (user && file === `claude-${user.base}.json`) {
				const json = JSON.parse(body);
				for (const [key, [r, g, b]] of Object.entries(user.colors))
					if (THEME_VARS[key]) json.vars[THEME_VARS[key]] = `#${[r, g, b].map(n => n.toString(16).padStart(2, "0")).join("")}`;
				body = `${JSON.stringify(json, null, "\t")}\n`;
			}
			const target = join(dest, file);
			if (!existsSync(target) || readFileSync(target, "utf8") !== body) writeFileSync(target, body);
		}
	} catch (err) {
		pi.logger.warn(`claude-view: theme install failed: ${err}`);
	}
}

// Claude Code's prompt: a gray rule above and below, `> ` gutter, status below. Claude Code
// tints the rules only for shell mode (pink); omp's `borderColor` also carries the thinking-level
// tint, so keep it only when it is the bash/python mode color.
function shellMode(borderColor: (s: string) => string): "bashMode" | "pythonMode" | undefined {
	const probe = borderColor("─");
	return probe === theme.fg("bashMode", "─") ? "bashMode" : probe === theme.fg("pythonMode", "─") ? "pythonMode" : undefined;
}

function rule(width: number, glyph: string, borderColor: (s: string) => string): string {
	const line = glyph.repeat(width);
	const mode = shellMode(borderColor);
	return theme.fg(mode ?? "border", line);
}

// omp keeps the `!`/`$` that enters shell mode in the input; Claude Code shows it as the
// prompt itself (`! ls`), in the mode color.
let firstRow = true;
const PROMPT: ComposerStyle = {
	id: "claude-view.prompt",
	filledSurface: false,
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "none",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: "❯ ",
	defaultPaddingX: () => 0,
	sideChromeWidth: () => 0,
	renderTop: ({ box, width, borderColor }) => {
		firstRow = true;
		return rule(width, box.horizontal, borderColor);
	},
	renderRow: ({ gutter, text, pad, borderColor }) => {
		const first = firstRow;
		firstRow = false;
		const mode = shellMode(borderColor);
		const sigil = mode === "bashMode" ? "!" : mode === "pythonMode" ? "$" : undefined;
		if (!first) return [gutter + text + pad];
		if (!sigil) {
			// omp pads the placeholder away from the cursor; Claude Code starts it at the cursor.
			let rest = text;
			let gap = 0;
			for (let next = dropLeadingChar(rest, " "); next !== undefined; next = dropLeadingChar(rest, " ")) {
				rest = next;
				gap++;
			}
			return gap && plain(rest).startsWith('Try "') ? [`${gutter}${rest}${" ".repeat(gap)}${pad}`] : [gutter + text + pad];
		}
		const rest = dropLeadingChar(text, sigil);
		if (rest === undefined) return [gutter + text + pad];
		return [`${theme.fg(mode!, `${sigil} `)}${rest} ${pad}`];
	},
	renderBottom: ({ box, width, borderColor }) => rule(width, box.horizontal, borderColor),
};

// Claude Code draws headings bold (H1 also italic) in the text color, not as colored lines.
function boldHeadings(text: string): string {
	let fence = false;
	return text
		.split("\n")
		.map(line => {
			if (/^\s*(```|~~~)/.test(line)) fence = !fence;
			const m = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
			if (!m) return line;
			return m[1].length === 1 ? `***${m[2]}***` : `**${m[2]}**`;
		})
		.join("\n");
}

// Settings that make up the Claude Code layout. Runtime layer only: never persisted,
// so disabling the plugin restores the user's own configuration.
const LOOK: Record<string, unknown> = {
	"theme.dark": "claude-dark",
	"theme.light": "claude-light",
	"composer.shape": PROMPT.id,
	// Claude Code's footer: the status line (index.ts `draw`) and the permission mode line.
	"statusLine.preset": "custom",
	"statusLine.leftSegments": [],
	"statusLine.rightSegments": [],
	"statusLine.separator": "none",
	"statusLine.showHookStatus": false,
	"composer.tokenRate": false,
	// Claude Code keeps thinking out of the transcript, leaving `✻ Thinking…` (patches.ts).
	hideThinkingBlock: true,
	"statusLine.sessionAccent": false,
	"tui.colorfulMarkdown": false,
	"startup.quiet": false,
	"display.showTokenUsage": false,
	"display.showTurnTime": false,
	"display.shimmer": "classic",
	"extensionRenderers.transcriptPresenters": true,
	"extensionRenderers.assistantText": true,
};

const VERBS: string[] = JSON.parse(readFileSync(fileURLToPath(new URL("./spinner-verbs.json", import.meta.url)), "utf8"));
// Claude Code's turn-summary verbs ("✻ Worked for 27s").
const DONE_VERBS = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"];
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];

function duration(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return [h && `${h}h`, (h || m) && `${m}m`, `${s % 60}s`].filter(Boolean).join(" ");
}

// Claude Code names models without the vendor: "Opus 5.5", not "Claude Opus 5.5".
function modelName(model: { name?: string; id?: string } | undefined): string {
	return (model?.name || model?.id || "").replace(/^Claude\s+/i, "");
}

// Claude Code's `up 1m` / `up 2h 5m`.
function uptime(ms: number): string {
	const m = Math.floor(ms / 60_000);
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Claude Code's empty-prompt examples, shown verbatim (`<filepath>` included), one per session.
const EXAMPLES = ["fix lint errors", "fix typecheck errors", "how do I log an error?", "create a util logging.py that...", "how does <filepath> work?", "refactor <filepath>", "edit <filepath> to...", "write a test for <filepath>"];

// Claude Code's mode line under the status line. omp's approval modes map onto Claude Code's
// permission modes (yolo = bypass, write = accept edits); plan mode wins when active.
function permissionMode(ctx: { sessionModes?: { getState(): { plan?: string } } }): string | undefined {
	if (ctx.sessionModes?.getState().plan === "active") return `\x1b[38;2;${cc("planMode")}m⏸ plan mode on\x1b[39m`;
	let mode: unknown;
	try {
		mode = lookup("tools.approvalMode")?.get(settingsScope);
	} catch {
		return undefined;
	}
	if (mode === "yolo") return theme.fg("error", "⏵⏵ bypass permissions on");
	if (mode === "write") return `\x1b[38;2;${cc("autoAccept")}m⏵⏵ accept edits on\x1b[39m`;
	return undefined;
}

let settingsScope: unknown;
let footer: (() => void) | undefined;
/** Agent busy time this session, for the ponytail band. */
let busyMs = 0;

// Cost of the session's assistant messages, in USD, and of the last one that had any.
function sessionCost(ctx: { sessionManager: { getEntries(): unknown[] } }): { spent: number; last?: number } {
	let spent = 0;
	let last: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const msg = entry && typeof entry === "object" && "message" in entry ? entry.message : undefined;
		if (!msg || typeof msg !== "object" || !("usage" in msg)) continue;
		const usage = msg.usage;
		const cost = usage && typeof usage === "object" && "cost" in usage ? usage.cost : undefined;
		const total = cost && typeof cost === "object" && "total" in cost && typeof cost.total === "number" ? cost.total : 0;
		if (total > 0) {
			spent += total;
			last = total;
		}
	}
	return { spent, last };
}

// ponytail's own `elapsed` (hooks/band/board.ts).
function bandElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function ponytailBand(width: number, ctx: { sessionManager: { getEntries(): unknown[] } }, effort: string | undefined): string[] {
	const status = [...hookStatuses.values()].find(v => /ponytail/i.test(v));
	if (!status) return [];
	const level = (/([A-Za-z]+)\s*$/.exec(status)?.[1] ?? "full").toLowerCase();
	const { spent, last } = sessionCost(ctx);
	const dot = level === "off" ? theme.fg("dim", "●") : theme.fg("customMessageLabel", "●");
	const left = [`${dot} ${level}`, `$${spent.toFixed(2)}`, ...(last !== undefined ? [theme.fg("dim", `last $${last.toFixed(2)}`)] : []), theme.fg("dim", bandElapsed(busyMs))].join("  ");
	const right = `${["Review", "Audit", "Board", "Details"].map(l => theme.bold(l)).join("  ")} ${theme.fg("dim", "[−]")}`;
	const fill = (l: string, r: string) => ` ${l}${" ".repeat(Math.max(1, width - 2 - plain(l).length - plain(r).length))}${r} `;
	const rows = [ANCHOR + fill(left, right)];
	if (effort && effort !== "off") rows.push(fill("", theme.fg("dim", `⊛ ${effort} · /effort`)));
	return rows;
}

export default function claudeView(pi: ExtensionAPI) {
	settingsScope = pi.pi.settings;
	installThemes(pi);
	installPatches();
	pi.registerComposerShape({ label: "Claude Code", description: "Prompt between two rules", style: PROMPT });
	for (const [id, value] of Object.entries(LOOK)) {
		try {
			const handle = lookup(id);
			// A theme the user picked (config.yml, /settings) wins; ours is only the default.
			if (id.startsWith("theme.") && handle?.provenance(pi.pi.settings) !== "default") continue;
			handle?.override(pi.pi.settings, value);
		} catch (err) {
			pi.logger.warn(`claude-view: cannot set ${id}: ${err}`);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		// Claude Code: "Opus 5.5 with xhigh effort", from the session's live model.
		headerInfo.model = () => {
			const name = modelName(ctx.models.current());
			if (!name) return "";
			const effort = pi.getThinkingLevel();
			return effort && effort !== "off" ? `${name} with ${effort} effort` : name;
		};
		headerInfo.cwd = ctx.cwd;
		placeholder.text = `Try "${pick(EXAMPLES)}"`;
		settingsUi.open = (native, usage) => {
			openSettings(settingsScope, ctx, VERSION, native, usage).catch(err => ctx.ui.notify(`Settings: ${err instanceof Error ? err.message : String(err)}`, "error"));
		};

		// Claude Code's footer under the prompt: the status line, then the permission mode.
		const started = Date.now();
		const draw = () => {
			const usage = ctx.getContextUsage();
			const effort = pi.getThinkingLevel();
			const parts = [
				`\x1b[96m${basename(ctx.cwd)}\x1b[39m`,
				[
					`\x1b[38;2;255;135;95m${modelName(ctx.models.current()) || "—"}\x1b[39m`,
					...(effort && effort !== "off" ? [`\x1b[38;2;255;135;0m${effort}\x1b[39m`, theme.fg("muted", "thinking")] : []),
				].join(theme.fg("muted", " · ")),
				`${theme.fg("muted", "ctx ")}\x1b[92m${Math.round(usage?.percent ?? 0)}%\x1b[39m`,
				theme.fg("muted", `up ${uptime(Date.now() - started)}`),
			];
			// A widget, not omp's status bar: the bar repaints segments in one accent color.
			const mode = permissionMode(ctx);
			ctx.ui.setWidget("claude-view-footer", [` ${parts.join(theme.fg("muted", " │ "))}`, ...(mode ? [` ${mode}`] : [])], { placement: "belowEditor" });
		};
		footer = draw;
		draw();
		ctx.setInterval(draw, 30_000);

		// The ponytail band Claude Code's ponytail plugin draws above the prompt:
		// `● full  $0.00  last $0.12  2m 5s` … `Review  Audit  Board  Details [−]`.
		ctx.ui.setWidget(
			"claude-view-ponytail",
			() => ({
				render: (width: number) => ponytailBand(width, ctx, pi.getThinkingLevel()),
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	});
	pi.on("turn_end", () => footer?.());
	// The mode line follows changes right away: plan mode, and the approval mode setting.
	pi.on("mode_changed", () => footer?.());
	try {
		lookup("tools.approvalMode")?.listen(pi.pi.settings, () => footer?.());
	} catch {
		// No listener support: the 30 s refresh and turn ends still update it.
	}
	pi.on("agent_end", () => footer?.());

	// Claude Code spinner: a random verb per turn ("Cogitating…"), then "✻ Worked for 27s".
	let startedAt = 0;
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		startedAt = Date.now();
		const verb = `${pick(VERBS)}…`;
		setTurnVerb(verb);
		turn.effort = pi.getThinkingLevel();
		ctx.ui.setWorkingMessage(verb);
	});
	// Spinner phase: ↑ while a request is out, ↓ while the reply streams, "thinking …" while it thinks.
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent.kind === "main") turn.phase = "requesting";
	});
	// Output tokens for the spinner's `↓ 1.2k tokens`: finished messages plus the streaming one.
	let doneTokens = 0;
	const output = (event: object): number => {
		if (!("message" in event)) return 0;
		const msg = event.message;
		if (!msg || typeof msg !== "object" || !("role" in msg) || msg.role !== "assistant" || !("usage" in msg)) return 0;
		const usage = msg.usage;
		return usage && typeof usage === "object" && "output" in usage && typeof usage.output === "number" ? usage.output : 0;
	};
	pi.on("message_update", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		turn.tokens = doneTokens + output(event);
		const content = contentOf(event);
		const lastPart = Array.isArray(content) ? content[content.length - 1] : undefined;
		const phase = lastPart && typeof lastPart === "object" && "type" in lastPart && lastPart.type === "thinking" ? "thinking" : "responding";
		if (phase === "thinking" && turn.phase !== "thinking") turn.thinkingSince = Date.now();
		turn.phase = phase;
		refresh(ctx.ui, indexRuns(content));
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		doneTokens += output(event);
		turn.tokens = doneTokens;
		refresh(ctx.ui, indexRuns(contentOf(event)));
	});

	// Wall time per call for "Did 1 search in 3s".
	const started = new Map<string, number>();
	// Main-agent calls only: subagent calls never show here, and background ones may never end.
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent.kind !== "main" || !("toolCallId" in event) || typeof event.toolCallId !== "string") return;
		started.set(event.toolCallId, Date.now());
	});
	pi.on("tool_execution_end", event => {
		if (!("toolCallId" in event) || typeof event.toolCallId !== "string") return;
		const t = started.get(event.toolCallId);
		if (t !== undefined) durations.set(event.toolCallId, Date.now() - t);
		started.delete(event.toolCallId);
		awaiting.delete(event.toolCallId);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !startedAt) return;
		setTurnVerb(undefined);
		doneTokens = 0;
		ctx.ui.notify(`✻ ${pick(DONE_VERBS)} for ${duration(Date.now() - startedAt)}`, "info");
		busyMs += Date.now() - startedAt;
		startedAt = 0;
	});

	// Headings drawn bold, as Claude Code does (the `●` column is drawn by patches.ts).
	pi.registerAssistantTextRenderer(({ text }) => {
		const shown = boldHeadings(text);
		return shown === text ? undefined : shown;
	});

	// The plugin also loads in every subagent session: only the main one owns these hooks.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		ui = ctx.ui;
		// omp asks for approval inside the call, right after tool_execution_start: the dialog
		// belongs to the latest started call not already waiting.
		// ponytail: start order, not an id from the dialog; parallel calls could swap labels.
		approvals.onOpen = () => {
			const call = [...started.keys()].reverse().find(id => !awaiting.has(id));
			if (call) {
				awaiting.add(call);
				refresh(ui, [call]);
			}
			return call;
		};
		approvals.onClose = call => {
			if (call && awaiting.delete(call)) refresh(ui, [call]);
		};
	});
	pi.registerTranscriptPresenter(raw => present(raw as unknown as AnyBlock));
	// The same drawing for omp's views that replay a transcript without presenters.
	presenters.tool = block => present(block as AnyBlock);
	presenters.reads = blocks => labelFor(blocks as Block[]);
}

type AnyBlock = Block & { message?: { customType?: string; content?: unknown }; event?: { type?: string; todos?: unknown[] } };
let ui: { refreshTranscript(ids: string[]): void } | undefined;

function present(block: AnyBlock) {
	// Read-only view; fields are narrowed where used.
	if (block.type === "message") return presentMessage(block.message);
	if (block.type === "event") return presentEvent(block.event);
	if (block.type !== "toolCall") return undefined;

	const run = runs.get(block.id);
	if (kindOf(block.toolName, block.args)) {
		const prev = seen.get(block.id);
		seen.set(block.id, block);
		// A member settled: the leader's summary counts it, so redraw the leader.
		if (run && run[0] !== block.id && (prev?.isPartial !== block.isPartial || prev?.isError !== block.isError)) refresh(ui, [run[0]]);
	}
	if (run) return run[0] === block.id ? { compact: { label: runLabel(run), rows: [] } } : "hidden";

	if (block.toolName === "task") {
		const agents = agentsOf(block);
		if (agents.length > 1) return agentGroup(agents, launched(block));
	}
	const [name, arg] = title(block);
	// Claude Code: bold name, red only on error; pending is dim.
	const s = block.isError ? "strong error" : block.isPartial || !block.result ? "strong dim" : "strong";
	const label: Span[] = [{ t: name, s }];
	if (arg) label.push({ t: `(${arg})`, s: block.isPartial ? "dim" : undefined });
	const rows = body(block).map((r, i): Text => {
		const prefix: Span = { t: i === 0 ? "⎿  " : "   ", s: "dim" };
		return typeof r === "string" ? [prefix, { t: r }] : [prefix, ...r];
	});
	return { compact: { label, rows } };
}

function contentOf(event: object): unknown {
	if (!("message" in event) || !event.message || typeof event.message !== "object") return undefined;
	const msg = event.message;
	return "role" in msg && msg.role === "assistant" && "content" in msg ? msg.content : undefined;
}

// Deferred: presenters and event handlers may run mid-draw.
function refresh(ui: { refreshTranscript(ids: string[]): void } | undefined, ids: string[]): void {
	if (!ui || ids.length === 0) return;
	queueMicrotask(() => ui.refreshTranscript(ids));
}

// Background job completions: Claude Code reports agents finishing in one dim line.
function presentMessage(message: { customType?: string; content?: unknown } | undefined) {
	if (message?.customType !== "async-result") return undefined;
	const text = String(message.content ?? "");
	const id = /<task-result id="([^"]+)"/.exec(text)?.[1] ?? /Background job (\S+)/.exec(text)?.[1] ?? "job";
	const status = /status="([^"]+)"/.exec(text)?.[1] ?? "completed";
	const took = /duration="([^"]+)"/.exec(text)?.[1];
	const label: Span[] = [{ t: id, s: "strong" }, { t: ` ${status}${took ? ` · ${took}` : ""}`, s: "dim" }];
	return { compact: { label, rows: [] } };
}

// omp's open-todo reminder: one dim line instead of omp's card.
function presentEvent(event: { type?: string; todos?: unknown[] } | undefined) {
	if (event?.type !== "todo_reminder") return undefined;
	const n = event.todos?.length ?? 0;
	return { compact: { label: [{ t: `${plural(n, "todo")} still open`, s: "dim" }], rows: [] } };
}
