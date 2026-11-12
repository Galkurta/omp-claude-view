// Claude Code's `/config` screen for omp's settings: tabs (`Settings  Status  Config  Usage
// Stats`), a `⌕ Search settings…` box, one `❯ Label   value` list, and the footer
// `Enter/Space to change · / to search · Esc to close`. Values come from and go to omp's own
// settings registry (`handle.set` writes the global config), so nothing is reimplemented
// besides the drawing. Text/number/list settings are edited through omp's input dialog;
// `Open omp settings ›` (last row) opens omp's full settings screen.
import { theme } from "@oh-my-pi/pi-coding-agent";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { cc } from "./patches.ts";

type Def = {
	id: string;
	type: string;
	values?: readonly unknown[];
	ui?: { tab?: string; group?: string; label?: string; description?: string; options?: unknown };
};
type Handle = { id: string; definition: Def; get(scope: unknown): unknown; set(scope: unknown, value: unknown): void; provenance?(scope: unknown): string };
type Row = { key: string; label: string; value: string; dim?: boolean; handle?: Handle; action?: string };
type Result = { kind: "close" } | { kind: "edit"; handle: Handle } | { kind: "native" } | { kind: "usage" };
type Keys = { matches(data: string, action: string): boolean };
type Ctx = {
	cwd: string;
	ui: {
		custom<T>(factory: (tui: unknown, th: unknown, keys: Keys, done: (r: T) => void) => object): Promise<T>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		notify(msg: string, kind?: string): void;
	};
	models: { current(): { name?: string; id?: string } | undefined };
	sessionManager: { getSessionId(): string; getEntries(): unknown[] };
	getContextUsage(): { percent?: number; tokens?: number; contextWindow?: number } | undefined;
};

const TABS = ["Status", "Config", "Usage", "Stats"] as const;
type Tab = (typeof TABS)[number];
// omp's settings tabs, in its own order: the flat list keeps related settings together.
const TAB_ORDER = ["appearance", "model", "interaction", "context", "memory", "files", "shell", "tools", "tasks", "providers"];

function handles(): Handle[] {
	const list = (all() as unknown as Handle[]).filter(h => h.definition?.ui?.label);
	const rank = (h: Handle) => {
		const i = TAB_ORDER.indexOf(h.definition.ui?.tab ?? "");
		return i < 0 ? TAB_ORDER.length : i;
	};
	return list.sort((a, b) => rank(a) - rank(b));
}

function show(value: unknown, def: Def): string {
	if (value === undefined || value === null || value === "") return "";
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	const text = String(value);
	return def.type === "enum" ? `${text} ›` : text;
}

const trunc = (s: string, n: number) => (n <= 1 ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

/** Opens the screen and handles its edits until it is closed. */
export async function openSettings(scope: unknown, ctx: Ctx, version: string, native: () => void, usage: () => void): Promise<void> {
	const state = { tab: "Config" as Tab, cursor: 0, query: "", searching: false, top: 0 };
	for (;;) {
		const result = await ctx.ui.custom<Result>((_tui, _th, keys, done) => screen(scope, ctx, version, state, keys, done));
		if (result.kind === "close") return;
		if (result.kind === "native") return run(ctx, "settings", native);
		if (result.kind === "usage") return run(ctx, "usage", usage);
		const h = result.handle;
		const label = h.definition.ui?.label ?? h.id;
		const current = h.get(scope);
		const answer = await ctx.ui.input(`${label}${h.definition.ui?.description ? ` — ${h.definition.ui.description}` : ""}`, show(current, h.definition));
		if (answer === undefined) continue;
		try {
			let value: unknown = answer;
			if (h.definition.type === "number") value = Number(answer);
			else if (h.definition.type === "array") value = answer.split(",").map(s => s.trim()).filter(Boolean);
			h.set(scope, value);
		} catch (err) {
			ctx.ui.notify(`${label}: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}
}

// Hands off to an omp screen; its failures (sync or async) become a notification, never an
// unhandled rejection.
async function run(ctx: Ctx, what: string, open: () => unknown): Promise<void> {
	try {
		await open();
	} catch (err) {
		ctx.ui.notify(`Could not open ${what}: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

function screen(scope: unknown, ctx: Ctx, version: string, state: { tab: Tab; cursor: number; query: string; searching: boolean; top: number }, keys: Keys, done: (r: Result) => void) {
	const configRows = (): Row[] => {
		const q = state.query.toLowerCase();
		const rows: Row[] = handles()
			.filter(h => !q || `${h.definition.ui?.label} ${h.definition.ui?.group ?? ""} ${h.id}`.toLowerCase().includes(q))
			.map(h => {
				let value: unknown;
				try {
					value = h.get(scope);
				} catch {
					value = undefined;
				}
				// Settings this plugin pins at runtime: shown, but a change would be overridden.
				const pinned = h.provenance?.(scope) === "runtime";
				return { key: h.id, label: h.definition.ui?.label ?? h.id, value: show(value, h.definition), dim: pinned, handle: h };
			});
		if (!q || "open omp settings".includes(q)) rows.push({ key: "native", label: "Open omp settings", value: "›", action: "native" });
		return rows;
	};
	const statusRows = (): Row[] => {
		const model = ctx.models.current();
		const usage = ctx.getContextUsage();
		return [
			{ key: "v", label: "Version", value: `omp v${version}` },
			{ key: "s", label: "Session ID", value: ctx.sessionManager.getSessionId() },
			{ key: "c", label: "cwd", value: ctx.cwd },
			{ key: "m", label: "Model", value: (model?.name ?? model?.id ?? "—").replace(/^Claude\s+/i, "") },
			{ key: "x", label: "Context", value: usage ? `${Math.round(usage.percent ?? 0)}% of ${usage.contextWindow ?? "?"} tokens` : "—" },
		];
	};
	const statsRows = (): Row[] => {
		let messages = 0;
		let tools = 0;
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			const msg = entry && typeof entry === "object" && "message" in entry ? (entry.message as Record<string, unknown>) : undefined;
			if (!msg) continue;
			messages++;
			if (msg.role === "toolResult") tools++;
			const u = msg.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
			input += u?.input ?? 0;
			output += u?.output ?? 0;
			cost += u?.cost?.total ?? 0;
		}
		return [
			{ key: "m", label: "Messages", value: String(messages) },
			{ key: "t", label: "Tool calls", value: String(tools) },
			{ key: "i", label: "Input tokens", value: input.toLocaleString() },
			{ key: "o", label: "Output tokens", value: output.toLocaleString() },
			{ key: "$", label: "Cost", value: `$${cost.toFixed(2)}` },
		];
	};
	const rowsFor = (): Row[] =>
		state.tab === "Config"
			? configRows()
			: state.tab === "Status"
				? statusRows()
				: state.tab === "Stats"
					? statsRows()
					: [{ key: "u", label: "Usage", value: "Enter to open the usage dashboard ›", action: "usage" }];

	const change = (row: Row | undefined) => {
		if (!row) return;
		if (row.action === "native") return done({ kind: "native" });
		if (row.action === "usage") return done({ kind: "usage" });
		const h = row.handle;
		if (!h) return;
		const def = h.definition;
		try {
			const current = h.get(scope);
			if (def.type === "boolean") return h.set(scope, !current);
			if (def.type === "enum" && def.values?.length) {
				const i = def.values.indexOf(current);
				return h.set(scope, def.values[(i + 1) % def.values.length]);
			}
		} catch (err) {
			ctx.ui.notify(`${def.ui?.label ?? h.id}: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		done({ kind: "edit", handle: h });
	};

	return {
		handleInput(data: string) {
			const rows = rowsFor();
			if (state.searching) {
				if (matchesKey(data, "escape") || matchesKey(data, "enter")) state.searching = false;
				else if (matchesKey(data, "backspace")) state.query = state.query.slice(0, -1);
				else if (data.length === 1 && data >= " ") state.query += data;
				state.cursor = 0;
				state.top = 0;
				return;
			}
			if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) return done({ kind: "close" });
			if (data === "/") {
				state.tab = "Config";
				state.searching = true;
				return;
			}
			if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
				state.tab = TABS[(TABS.indexOf(state.tab) + TABS.length - 1) % TABS.length];
				state.cursor = 0;
				state.top = 0;
				return;
			}
			if (matchesKey(data, "right") || matchesKey(data, "tab")) {
				state.tab = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length];
				state.cursor = 0;
				state.top = 0;
				return;
			}
			if (keys.matches(data, "tui.select.up") || matchesKey(data, "up")) state.cursor = Math.max(0, state.cursor - 1);
			else if (keys.matches(data, "tui.select.down") || matchesKey(data, "down")) state.cursor = Math.min(rows.length - 1, state.cursor + 1);
			else if (keys.matches(data, "tui.select.pageUp")) state.cursor = Math.max(0, state.cursor - 10);
			else if (keys.matches(data, "tui.select.pageDown")) state.cursor = Math.min(rows.length - 1, state.cursor + 10);
			else if (keys.matches(data, "tui.select.confirm") || data === " ") change(rows[state.cursor]);
		},
		render(width: number): string[] {
			const rows = rowsFor();
			state.cursor = Math.min(state.cursor, Math.max(0, rows.length - 1));
			const out: string[] = [theme.fg("border", "─".repeat(width))];
			const tabs = TABS.map(t => (t === state.tab ? `\x1b[7m\x1b[1m ${t} \x1b[22m\x1b[27m` : ` ${t} `)).join(" ");
			out.push(`  \x1b[38;2;${cc("suggestion")}m${theme.bold("Settings")}\x1b[39m ${tabs}`, "");
			// Search box.
			const inner = Math.max(10, width - 6);
			const text = state.query || (state.searching ? "" : "Search settings…");
			const shown = `${theme.fg("dim", "⌕")} ${state.query ? state.query : theme.fg("dim", text)}${state.searching ? "▏" : ""}`;
			const shownLen = 2 + (state.query ? state.query.length : text.length) + (state.searching ? 1 : 0);
			out.push(`  ${theme.fg("border", `╭${"─".repeat(inner)}╮`)}`);
			out.push(`  ${theme.fg("border", "│")} ${shown}${" ".repeat(Math.max(0, inner - 1 - shownLen))}${theme.fg("border", "│")}`);
			out.push(`  ${theme.fg("border", `╰${"─".repeat(inner)}╯`)}`, "");
			// The list, scrolled to keep the cursor visible.
			const height = Math.max(5, (process.stdout.rows || 40) - out.length - 4);
			if (state.cursor < state.top) state.top = state.cursor;
			if (state.cursor >= state.top + height) state.top = state.cursor - height + 1;
			const labelW = Math.min(Math.max(10, ...rows.map(r => r.label.length)) + 2, Math.floor(width / 2));
			for (const [i, row] of rows.slice(state.top, state.top + height).entries()) {
				const selected = state.top + i === state.cursor;
				const line = `${pad(trunc(row.label, labelW - 2), labelW)}${trunc(row.value, width - labelW - 4)}`;
				out.push(selected ? `\x1b[38;2;${cc("suggestion")}m❯ ${line}\x1b[39m` : row.dim ? `  ${theme.fg("dim", line)}` : `  ${line}`);
			}
			if (rows.length === 0) out.push(`  ${theme.fg("dim", "No settings match")}`);
			out.push("", `  ${theme.fg("dim", state.searching ? "Type to filter · Enter/Esc to finish" : "Enter/Space to change · / to search · Esc to close")}`);
			return out;
		},
		invalidate() {},
	};
}
