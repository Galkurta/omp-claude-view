// Runtime patches on omp's own transcript components, for the parts of Claude Code's look
// the extension API cannot express. Every patch wraps a public method of a class exported
// from the package root, keeps the original output as the source of truth, and memoizes on
// the original row array so components stay reference-stable for the transcript renderer.
// If omp renames a class or changes the row shape, the affected patch is skipped/no-ops.
import * as host from "@oh-my-pi/pi-coding-agent";
import { theme } from "@oh-my-pi/pi-coding-agent";

type Rows = readonly string[];
type Proto = Record<string, unknown>;
type Status = "running" | "success" | "error";

const PATCHED = Symbol.for("omp-claude-view.patched");

/**
 * Claude Code colors without an omp theme key, as `r;g;b` per variant. index.ts layers the
 * user's own Claude Code theme (`/theme` custom themes in ~/.claude/themes) on top.
 */
export const ccColors: Record<"dark" | "light", Record<string, string>> = {
	dark: {
		suggestion: "177;185;249",
		claudeShimmer: "245;149;117",
		planMode: "72;150;140",
		autoAccept: "175;135;255",
		diffAdded: "34;92;43",
		diffRemoved: "122;41;54",
		diffAddedWord: "56;166;96",
		diffRemovedWord: "179;89;107",
	},
	light: {
		suggestion: "87;105;247",
		claudeShimmer: "245;149;117",
		planMode: "72;150;140",
		autoAccept: "175;135;255",
		diffAdded: "105;219;124",
		diffRemoved: "255;168;180",
		diffAddedWord: "47;157;68",
		diffRemovedWord: "209;69;75",
	},
};
export const cc = (key: string): string => (theme.isLight ? ccColors.light : ccColors.dark)[key];
// CSI, OSC/APC (BEL or ST terminated; the TUI's cursor marker is an APC) and two-byte escapes:
// zero-width for layout purposes.
const ESCAPE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/y;

/** Index and text of each visible code point in an ANSI-styled row. */
function visible(row: string): Array<[number, string]> {
	const out: Array<[number, string]> = [];
	let i = 0;
	while (i < row.length) {
		ESCAPE.lastIndex = i;
		const esc = ESCAPE.exec(row);
		if (esc) {
			i += esc[0].length;
			continue;
		}
		const ch = String.fromCodePoint(row.codePointAt(i)!);
		out.push([i, ch]);
		i += ch.length;
	}
	return out;
}

const splice = (row: string, at: number, len: number, insert: string) => row.slice(0, at) + insert + row.slice(at + len);

/** `text` without its first visible character when that is `ch` (escapes and the cursor kept). */
export function dropLeadingChar(text: string, ch: string): string | undefined {
	const first = visible(text)[0];
	if (!first || first[1] !== ch) return undefined;
	return text.slice(0, first[0]) + text.slice(first[0] + ch.length);
}

// Wraps `proto[method]`; `wrap` receives the original and returns the replacement.
function patch(cls: unknown, method: string, wrap: (orig: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown) {
	const proto = (cls as { prototype?: Proto } | undefined)?.prototype;
	const orig = proto?.[method];
	if (!proto || typeof orig !== "function") return;
	const marks = (proto[PATCHED as unknown as string] ??= new Set<string>()) as Set<string>;
	if (marks.has(method)) return;
	marks.add(method);
	proto[method] = wrap(orig as (...args: unknown[]) => unknown);
}

// Per-source-array memo: same input rows + same key ⇒ same output array.
function memo(fn: (rows: Rows, key: string) => Rows) {
	const cache = new WeakMap<Rows, { key: string; out: Rows }>();
	return (rows: Rows, key: string): Rows => {
		const hit = cache.get(rows);
		if (hit && hit.key === key) return hit.out;
		const out = fn(rows, key);
		cache.set(rows, { key, out });
		return out;
	};
}

// ── Tool rows: omp draws a dim `•` (or a spinner frame) before compact rows; Claude Code
// draws `●`: green when done, red on error, blinking gray while running.
const toolStatus = new WeakMap<object, Status>();
const BLINK_MS = 600;

function bulletFor(status: Status): string {
	if (status === "success") return theme.fg("success", "●");
	if (status === "error") return theme.fg("error", "●");
	return Math.floor(Date.now() / BLINK_MS) % 2 ? theme.fg("dim", "●") : " ";
}

function isBullet(ch: string): boolean {
	return ch === "•" || theme.spinnerFrames.includes(ch);
}

const recolorFirst = memo((rows, key) => {
	const first = rows[0];
	if (first === undefined) return rows;
	const vis = visible(first);
	if (vis.length < 2 || !isBullet(vis[0][1]) || vis[1][1] !== " ") return rows;
	const out = rows.slice();
	out[0] = splice(first, vis[0][0], vis[0][1].length, bulletFor(key.split(":")[0] as Status));
	return out;
});

// Grouped reads: one compact row per file, each led by `•` (success) or a status icon.
const recolorReads = memo(rows => {
	let changed = false;
	const out = rows.map(row => {
		const vis = visible(row);
		if (vis.length < 2 || vis[0][1] !== "•" || vis[1][1] !== " ") return row;
		changed = true;
		return splice(row, vis[0][0], 1, theme.fg("success", "●"));
	});
	return changed ? out : rows;
});

// ── User prompt: Claude Code shows `❯ ` in gray before the first line of a sent prompt,
// with continuation lines indented to match. The bubble already pads one cell on each
// side; we widen the left padding by one cell and take it back from the right padding.
// Claude Code's prompt echo is one tinted row per line, `❯ text`, with no padding rows.
const promptRows = memo(rows => {
	let first = true;
	return rows.flatMap(row => {
		const vis = visible(row);
		if (vis.length >= 2 && vis.every(([, ch]) => ch === " ")) return [];
		if (vis.length < 2) return [row];
		const last = vis[vis.length - 1];
		if (vis[0][1] !== " " || last[1] !== " ") return [row];
		const lead = first ? `${theme.fg("muted", "❯")} ` : "  ";
		first = false;
		return [splice(splice(row, last[0], 1, ""), vis[0][0], 1, lead)];
	});
});

// ── Header: Claude Code's layout (logo, name/version, model, cwd) with omp's own π logo.
// `model` is read on every draw, so /model switches and effort changes show up live.
export const headerInfo: { model: () => string; cwd: string } = { model: () => "", cwd: process.cwd() };

/** Cells [start, end) of an ANSI row, keeping every escape so colors carry over. */
function cut(row: string, start: number, end: number): string {
	let out = "";
	let cell = 0;
	let i = 0;
	while (i < row.length) {
		ESCAPE.lastIndex = i;
		const esc = ESCAPE.exec(row);
		if (esc) {
			out += esc[0];
			i += esc[0].length;
			continue;
		}
		const ch = String.fromCodePoint(row.codePointAt(i)!);
		if (cell >= start && cell < end) out += ch;
		cell++;
		i += ch.length;
	}
	return `${out}\x1b[0m`;
}

export const plain = (row: string) => visible(row).map(([, ch]) => ch).join("");

/**
 * omp's welcome draws the gradient π logo with the wordmark to its right, centered. Its
 * leading rows up to the first blank one are the logo; the top row holds only the logo
 * bar, so it gives the logo's column range. Undefined when the layout is not recognized.
 */
function ompLogo(rows: Rows): string[] | undefined {
	const first = rows.findIndex(r => plain(r).trim() !== "");
	if (first < 0) return undefined;
	const end = rows.findIndex((r, i) => i > first && plain(r).trim() === "");
	const art = rows.slice(first, end < 0 ? rows.length : end);
	if (art.length < 3) return undefined;
	const top = plain(art[0]);
	const start = top.length - top.trimStart().length;
	const width = top.trim().length;
	if (width < 4 || !/^[█▀▄▒▓░▐▌]+$/.test(top.trim())) return undefined;
	return art.map(r => cut(r, start, start + width));
}

// Fallback when omp's welcome layout changes: a plain π in the same footprint.
const PI_LOGO = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

function headerRows(version: string, logo: string[] | undefined): string[] {
	const art = logo ?? PI_LOGO.map(r => theme.fg("accent", r));
	const muted = (s: string) => theme.fg("muted", s);
	// Text sits beside the logo's top rows, as Claude Code's sits beside its mascot.
	const text = [`${theme.bold("omp")} ${muted(`v${version}`)}`, muted(headerInfo.model() || "—"), muted(headerInfo.cwd)];
	return [...art.map((row, i) => (i < text.length ? `${row}  ${text[i]}` : row)), ""];
}

export function installPatches(): void {
	const h = host as unknown as Record<string, unknown>;
	// omp's theme styles bold/italic through a chalk instance that detects color level 0 on
	// Windows terminals, so `theme.bold` returns plain text everywhere (markdown **strong**,
	// headings, labels). Claude Code relies on bold and italic: emit the SGR directly, only
	// when omp's own call would drop it.
	const themeProto = Object.getPrototypeOf(theme) as Proto;
	const sgr: Record<string, [string, string]> = { bold: ["\x1b[1m", "\x1b[22m"], italic: ["\x1b[3m", "\x1b[23m"] };
	for (const [method, [on, off]] of Object.entries(sgr))
		patch({ prototype: themeProto }, method, orig =>
			function (this: object, ...args: unknown[]) {
				const out = orig.apply(this, args);
				return typeof args[0] === "string" && out === args[0] && args[0] ? `${on}${args[0]}${off}` : out;
			},
		);

	patch(h.ToolExecutionComponent, "updateResult", orig =>
		function (this: object, ...args: unknown[]) {
			const [result, isPartial] = args as [ToolResult | undefined, boolean | undefined];
			toolStatus.set(this, isPartial ? "running" : result?.isError ? "error" : "success");
			if (result && !isPartial) results.set(this, result);
			versions.set(this, (versions.get(this) ?? 0) + 1);
			return orig.apply(this, args);
		},
	);
	// Compaction: Claude Code's one dim row; the summary card stays behind Ctrl+O.
	patch(h.CompactionSummaryMessageComponent, "render", orig =>
		function (this: object, ...args: unknown[]) {
			if (expanded.get(this)) return orig.apply(this, args);
			return compactedRows(COMPACT_KEY, String(theme.isLight));
		},
	);
	for (const cls of [h.ToolExecutionComponent, h.ReadToolGroupComponent, h.CompactionSummaryMessageComponent])
		patch(cls, "setExpanded", orig =>
			function (this: object, ...args: unknown[]) {
				expanded.set(this, args[0] === true);
				return orig.apply(this, args);
			},
		);
	patch(h.ToolExecutionComponent, "render", orig =>
		function (this: object, ...args: unknown[]) {
			const width = Number(args[0]) || 120;
			const status = toolStatus.get(this) ?? "running";
			const phase = status === "running" ? Math.floor(Date.now() / BLINK_MS) % 2 : 0;
			const call = replayCalls.get(this);
			if (call && !expanded.get(this) && presenters.tool) {
				const r = results.get(this);
				const block = {
					type: "toolCall",
					id: call.id,
					toolName: call.name,
					args: call.args,
					result: r ? { content: r.content, details: r.details } : undefined,
					isError: r?.isError === true,
					isPartial: !r,
				};
				return replayRows(this, presenters.tool(block), width, status, `${versions.get(this) ?? 0}:${phase}`);
			}
			return paintDiff(recolorFirst(orig.apply(this, args) as Rows, `${status}:${phase}`), `${width}:${theme.isLight}`);
		},
	);
	// Read groups record their calls by id, in the main transcript and replays alike.
	patch(h.ReadToolGroupComponent, "updateArgs", orig =>
		function (this: object, ...args: unknown[]) {
			const [a, id] = args as [Record<string, unknown> | undefined, string | undefined];
			if (id) groupCalls(this).set(id, { ...groupCalls(this).get(id), args: a });
			versions.set(this, (versions.get(this) ?? 0) + 1);
			return orig.apply(this, args);
		},
	);
	patch(h.ReadToolGroupComponent, "updateResult", orig =>
		function (this: object, ...args: unknown[]) {
			const [r, partial, id] = args as [ToolResult | undefined, boolean | undefined, string | undefined];
			if (id && r && !partial) groupCalls(this).set(id, { ...groupCalls(this).get(id), result: r });
			versions.set(this, (versions.get(this) ?? 0) + 1);
			return orig.apply(this, args);
		},
	);
	patch(h.ReadToolGroupComponent, "render", orig =>
		function (this: object, ...args: unknown[]) {
			if (replayGroups.has(this) && !expanded.get(this) && presenters.tool && presenters.reads) {
				const blocks = [...groupCalls(this)].map(([id, c]) => ({
					type: "toolCall",
					id,
					toolName: "read",
					args: c.args,
					result: c.result ? { content: c.result.content, details: c.result.details } : undefined,
					isError: c.result?.isError === true,
					isPartial: !c.result,
				}));
				const failed = blocks.some(b => b.isError);
				const status: Status = blocks.some(b => b.isPartial) ? "running" : failed ? "error" : "success";
				const answer = blocks.length >= 2 ? { compact: { label: presenters.reads(blocks), rows: [] } } : presenters.tool(blocks[0] ?? {});
				return replayRows(this, answer, Number(args[0]) || 120, status, String(versions.get(this) ?? 0));
			}
			return recolorReads(orig.apply(this, args) as Rows, "");
		},
	);
	// omp's views that replay a transcript (focused subagent, Agent Hub, rewind/copy/link
	// pickers) build their blocks through ChatTranscriptBuilder with presenters switched off.
	// Bind each tool block it creates to its call, so those views draw the same rows.
	import("@oh-my-pi/pi-tui/chat/chat-transcript-builder")
		.then(mod => {
			for (const method of ["append", "rebuild"])
				patch((mod as Record<string, unknown>).ChatTranscriptBuilder, method, orig =>
					function (this: { container?: { children?: unknown[] } }, ...args: unknown[]) {
						const out = orig.apply(this, args);
						try {
							bindReplay(this, args[0], h);
						} catch {
							// Unrecognized shapes: the view keeps omp's own cards.
						}
						return out;
					},
				);
		})
		.catch(() => {});
	// A focused subagent: omp clears the presenter list whenever the viewed session is not the
	// main one (`renderInitialMessages`), then replays that session. Put Claude's drawing back
	// just before each replay; returning to the main session restores omp's own list.
	import("@oh-my-pi/pi-tui/chat/transcript-presentation")
		.then(mod => {
			const m = mod as Record<string, unknown>;
			const set = m.setTranscriptPresenters as ((list: unknown[]) => boolean) | undefined;
			const read = m.readTranscriptPresentation as ((answer: unknown) => unknown) | undefined;
			if (!set || !read) return;
			const focused = (block: object) => (presenters.tool ? read(presenters.tool(block)) : undefined);
			for (const method of ["renderSessionContext", "renderSessionContextIncrementally"])
				patch(h.InteractiveMode, method, orig =>
					function (this: { viewSession?: unknown; session?: unknown; collabGuest?: unknown }, ...args: unknown[]) {
						if (this.viewSession !== this.session && !this.collabGuest) set([focused]);
						return orig.apply(this, args);
					},
				);
		})
		.catch(() => {});
	// Claude Code shows no key hints beside the prompt (omp's "⇧⇥ to change thinking effort"):
	// empty omp's hint table, so its resolver finds nothing to show.
	import("@oh-my-pi/pi-tui/prompt/composer-hints")
		.then(mod => {
			for (const value of Object.values(mod as Record<string, unknown>))
				if (Array.isArray(value) && value.every(v => v && typeof v === "object" && "learnedAfter" in v)) value.splice(0);
		})
		.catch(() => {});
	// Claude Code has no attachment card strip above the prompt: a paste or image is only its
	// inline `[Pasted text #1 +16 lines]` / `[Image #1]` label. Render omp's strip from an empty
	// chip list (both its render and describe paths).
	import("@oh-my-pi/pi-tui/prompt/attachment-chips")
		.then(mod => {
			const none: unknown[] = [];
			const empty = { composerChips: () => none };
			for (const cls of Object.values(mod as Record<string, unknown>)) {
				for (const method of ["render", "describe"])
					patch(cls, method, orig =>
						function (this: { editor?: unknown }, ...args: unknown[]) {
							const editor = this.editor;
							this.editor = empty;
							try {
								return orig.apply(this, args);
							} finally {
								this.editor = editor;
							}
						},
					);
			}
		})
		.catch(() => {});
	// Claude Code's dim `Try "…"` placeholder in the empty prompt, until the first message.
	patch(h.InteractiveMode, "updateEditorBorderColor", orig =>
		function (this: { editor?: Record<string | symbol, unknown>; composer?: object; ui?: object; viewSession?: { messages?: unknown[] } }, ...args: unknown[]) {
			const editor = this.editor;
			if (editor && !editor[PATCHED]) {
				editor[PATCHED] = true;
				const prev = typeof editor.placeholder === "function" ? (editor.placeholder as () => string | undefined) : undefined;
				// omp right-aligns a placeholder (`spaces + text`, at least 2 spaces): pad it to the row;
				// the prompt row (index.ts) then drops the 2 leading spaces so it starts at the cursor.
				editor.placeholder = () => {
					const own = prev?.();
					if (own || this.viewSession?.messages?.length || !placeholder.text) return own || undefined;
					const room = Math.max(0, (process.stdout.columns || 80) - 2 - 1 - 2);
					const text = placeholder.text.length > room ? `${placeholder.text.slice(0, Math.max(0, room - 1))}…` : placeholder.text;
					return theme.fg("dim", text) + " ".repeat(Math.max(0, room - text.length));
				};
			}
			if (editor && !editor[CHIP_LABELS] && typeof editor.decorateText === "function") {
				editor[CHIP_LABELS] = true;
				const decorate = editor.decorateText as (text: string, at: unknown) => string;
				editor.decorateText = (text: string, at: unknown) => chipLabels(decorate(text, at), text, editor);
			}
			// The composer is omp's frame provider. Claude Code keeps the prompt at the bottom of the
			// screen while the transcript is shorter than it; pad the frame above the prompt area.
			if (this.composer) patch({ prototype: Object.getPrototypeOf(this.composer) }, "renderFrame", bottomAnchor);
			// With the frame as tall as the terminal, closing a full-screen overlay leaves its first
			// and last rows on screen: rows the base frame did not change are not repainted. Repaint
			// the whole frame (scrollback kept) whenever an overlay closes.
			if (this.ui) repaintOnOverlayClose(Object.getPrototypeOf(this.ui));
			return orig.apply(this, args);
		},
	);
	// `/settings` opens the Claude Code-style config screen (settings.ts); it can still open omp's.
	patch(h.InteractiveMode, "showSettingsSelector", orig =>
		function (this: { handleUsageCommand?: () => unknown }, ...args: unknown[]) {
			if (!settingsUi.open) return orig.apply(this, args);
			settingsUi.open(
				() => orig.apply(this, args),
				// omp's /usage path: it fetches the usage reports, then opens the dashboard.
				() => this.handleUsageCommand?.(),
			);
		},
	);
	// Extension statuses (`ctx.ui.setStatus`, e.g. ponytail's level), read by the ponytail band.
	patch(h.StatusLineComponent, "setHookStatus", orig =>
		function (this: object, ...args: unknown[]) {
			const [key, text] = args;
			if (typeof key === "string") {
				if (typeof text === "string") hookStatuses.set(key, plain(text));
				else hookStatuses.delete(key);
			}
			return orig.apply(this, args);
		},
	);
	// System notices: Claude Code shows them as dim `⎿  text` rows; it never reports MCP
	// connections in the transcript.
	for (const method of ["showStatus", "showHookNotify"])
		patch(h.InteractiveMode, method, orig =>
			function (this: object, ...args: unknown[]) {
				const [msg, kind] = args;
				if (typeof msg !== "string" || (kind !== undefined && typeof kind === "string" && kind !== "info")) return orig.apply(this, args);
				// MCP connection progress and omp's xd:// device mounts have no Claude Code counterpart.
				if (/^(Connect(ed|ing)( to MCP servers?)?|Still connecting|MCP)\b.*:|^xdev:/.test(msg)) return;
				if (msg.startsWith("✻") || msg.startsWith("⎿")) return orig.apply(this, args);
				return orig.call(this, `⎿  ${msg}`, ...args.slice(1));
			},
		);
	// omp reacts to some prompts with an emoji on the message's top row; Claude Code does not.
	patch(h.UserMessageComponent, "setReaction", () => function () {});
	patch(h.UserMessageComponent, "render", orig =>
		function (this: object, ...args: unknown[]) {
			return promptRows(orig.apply(this, args) as Rows, "");
		},
	);
	// Claude Code marks a call that waits on the permission dialog `Waiting for permission…`.
	import("@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller")
		.then(mod => {
			patch((mod as Record<string, unknown>).ExtensionUiController, "showCollabAwareApproval", orig =>
				async function (this: object, ...args: unknown[]) {
					const call = approvals.onOpen?.();
					try {
						return await orig.apply(this, args);
					} finally {
						approvals.onClose?.(call);
					}
				},
			);
		})
		.catch(() => {});
	// `!cmd` runs: Claude Code echoes `! cmd` like a prompt, with the output in the `⎿` gutter,
	// instead of omp's ruled `$ cmd` box.
	patch(h.BashExecutionComponent, "render", orig =>
		function (this: { isTranscriptBlockFinalized?: () => boolean }, ...args: unknown[]) {
			const rows = orig.apply(this, args) as Rows;
			return bangRows(rows, `${Number(args[0]) || 80}:${this.isTranscriptBlockFinalized?.() === false ? 0 : 1}`);
		},
	);
	patch(h.WelcomeComponent, "render", orig =>
		function (this: { version?: string }, ...args: unknown[]) {
			// Wide render: the logo is drawn only when the welcome has room for it.
			const rows = orig.call(this, Math.max(Number(args[0]) || 0, 120)) as Rows;
			return headerRows(String(this.version ?? ""), ompLogo(rows));
		},
	);
	// omp replaces the working message with each tool's intent ("Running sleep command");
	// Claude Code keeps its verb for the whole turn.
	patch(h.InteractiveMode, "setWorkingMessage", orig =>
		function (this: object, ...args: unknown[]) {
			const msg = args[0];
			if (turn.verb && (msg === undefined || typeof msg === "string")) return orig.call(this, turn.verb);
			return orig.apply(this, args);
		},
	);
	// The loader instance is private to omp; wrap its render each time omp creates one.
	patch(h.InteractiveMode, "ensureLoadingAnimation", orig =>
		function (this: { loadingAnimation?: { render?: (w: number) => Rows } & Record<symbol, boolean> }, ...args: unknown[]) {
			const out = orig.apply(this, args);
			const loader = this.loadingAnimation;
			if (loader && typeof loader.render === "function" && !loader[PATCHED]) {
				loader[PATCHED] = true;
				const render = loader.render.bind(loader);
				loader.render = (width: number) => (turn.verb ? spinnerRows(width) : render(width));
			}
			return out;
		},
	);
	// Thinking: omp (with hideThinkingBlock) drops the block once it ends; Claude Code keeps a
	// dim italic `✻ Thinking…` row where it was. The message is recorded from updateContent;
	// both render paths (live and scrollback stable rows) get the same row so they agree.
	patch(h.AssistantMessageComponent, "updateContent", orig =>
		function (this: object, ...args: unknown[]) {
			const msg = args[0] as { content?: Array<{ type: string; thinking?: string }> } | undefined;
			thinks.set(this, msg?.content?.some(c => c.type === "thinking" && !!c.thinking?.trim()) === true);
			return orig.apply(this, args);
		},
	);
	// Replies are drawn one cell narrower and given Claude Code's `●` column: the dot before the
	// first text row, the text (and its wrapped lines) two cells in.
	patch(h.AssistantMessageComponent, "render", orig =>
		function (this: object, ...args: unknown[]) {
			const width = Number(args[0]) || 80;
			return withThinking(orig.call(this, Math.max(1, width - 1), ...args.slice(1)) as Rows, thinks.get(this) ? "1" : "");
		},
	);
	patch(h.AssistantMessageComponent, "renderTranscriptStableRows", orig =>
		function (this: object, ...args: unknown[]) {
			const [count, width, ...rest] = args;
			const rows = orig.call(this, count, Math.max(1, (Number(width) || 80) - 1), ...rest) as Rows;
			return rows.length ? withThinking(rows, thinks.get(this) ? "1" : "") : rows;
		},
	);
	// The approval dialog is not exported from the package root; import its module lazily so
	// a moved file only skips this patch instead of failing the whole extension.
	import("@oh-my-pi/pi-tui/overlays/approval-dialog")
		.then(mod => {
			patch((mod as Record<string, unknown>).ApprovalDialogComponent, "render", orig =>
				function (this: object, ...args: unknown[]) {
					return approvalRows(orig.apply(this, args) as Rows, `${theme.isLight}:${Number(args[0]) || 80}`);
				},
			);
		})
		.catch(() => {});
	// The `ask` tool's form dialog (`html-form/dialog`): Claude Code's AskUserQuestion layout.
	import("@oh-my-pi/pi-tui/html-form/dialog")
		.then(mod => {
			for (const cls of Object.values(mod as Record<string, unknown>)) {
				const proto = (cls as { prototype?: Proto } | undefined)?.prototype;
				if (typeof proto?.render !== "function" || typeof proto?.handleInput !== "function") continue;
				patch(cls, "render", orig =>
					function (this: object, ...args: unknown[]) {
						return askRows(orig.apply(this, args) as Rows, `${theme.isLight}:${Number(args[0]) || 80}`);
					},
				);
			}
		})
		.catch(() => {});
}

// Built on first draw (the theme is not loaded when this module is), stable per theme variant.
const compactedRows = memo(() => ["", ` ${theme.fg("dim", "✻ Conversation compacted (ctrl+o for history)")}`]);
const COMPACT_KEY: Rows = [];

// ── Replay views.
type ToolResult = { content?: unknown; details?: unknown; isError?: boolean };
type Answer = unknown;
/** Presenter logic from index.ts, shared with the views omp draws without presenters. */
export const presenters: { tool?: (block: object) => Answer; reads?: (blocks: object[]) => unknown } = {};
/** The empty-prompt placeholder text (`Try "…"`), chosen per session by index.ts. */
export const placeholder: { text?: string } = {};
/** Opens the config screen; set by index.ts for the main session. */
export const settingsUi: { open?: (native: () => unknown, usage: () => unknown) => void } = {};
/** Permission dialog open/close hooks; index.ts marks the call that waits on it. */
export const approvals: { onOpen?: () => string | undefined; onClose?: (call: string | undefined) => void } = {};
/** Latest status text per extension key (ANSI stripped), from `setHookStatus`. */
export const hookStatuses = new Map<string, string>();

const results = new WeakMap<object, ToolResult>();
const versions = new WeakMap<object, number>();
const expanded = new WeakMap<object, boolean>();
const replayCalls = new WeakMap<object, { id: string; name: string; args: unknown }>();
const replayGroups = new WeakSet<object>();
const groupMap = new WeakMap<object, Map<string, { args?: Record<string, unknown>; result?: ToolResult }>>();
const groupCalls = (g: object) => {
	let m = groupMap.get(g);
	if (!m) groupMap.set(g, (m = new Map()));
	return m;
};
// Tool calls a builder has seen but not yet bound to a block, per builder, in order.
const pending = new WeakMap<object, Array<{ id: string; name: string; args: unknown }>>();

function toolCallsOf(entries: unknown): Array<{ id: string; name: string; args: unknown }> {
	if (!Array.isArray(entries)) return [];
	const out: Array<{ id: string; name: string; args: unknown }> = [];
	for (const entry of entries) {
		const msg = entry && typeof entry === "object" && "message" in entry ? entry.message : entry;
		const content = msg && typeof msg === "object" && "content" in msg ? msg.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
				out.push({ id: part.id, name: part.name, args: part.arguments });
		}
	}
	return out;
}

// A tool block's name, from the role of its native description (`omp.tool.<name>`).
function toolNameOf(component: { describe?: (cx?: unknown) => unknown }): string | undefined {
	let node: unknown;
	try {
		node = component.describe?.();
	} catch {
		return undefined;
	}
	const stack = [node];
	for (let i = 0; i < 400 && stack.length; i++) {
		const v = stack.pop();
		if (typeof v === "string") {
			if (v.startsWith("omp.tool.")) return v.slice("omp.tool.".length);
			continue;
		}
		if (v && typeof v === "object") stack.push(...Object.values(v));
	}
	return undefined;
}

function bindReplay(builder: { container?: { children?: unknown[] } }, entries: unknown, h: Record<string, unknown>): void {
	const queue = pending.get(builder) ?? [];
	queue.push(...toolCallsOf(entries));
	pending.set(builder, queue);
	const Tool = h.ToolExecutionComponent as Function;
	const Group = h.ReadToolGroupComponent as Function;
	for (const child of builder.container?.children ?? []) {
		if (!child || typeof child !== "object") continue;
		if (child instanceof Group) {
			replayGroups.add(child);
			continue;
		}
		if (!(child instanceof Tool) || replayCalls.has(child)) continue;
		const name = toolNameOf(child as { describe?: () => unknown });
		const at = queue.findIndex(c => c.name === name);
		if (at < 0) continue;
		replayCalls.set(child, queue[at]);
		queue.splice(at, 1);
	}
}

const replayCache = new WeakMap<object, { key: string; rows: Rows }>();

/** Draw a presenter answer the way omp draws compact rows: `● label`, then `  ` + each row. */
function replayRows(owner: object, answer: Answer, width: number, status: Status, version: string): Rows {
	const key = `${width}|${status}|${version}|${theme.isLight}`;
	const hit = replayCache.get(owner);
	if (hit && hit.key === key) return hit.rows;
	let rows: Rows = [];
	if (answer && typeof answer === "object" && "compact" in answer) {
		const c = answer.compact as { label?: unknown; rows?: unknown[] };
		const line = (host as unknown as { spansLine: (t: unknown) => string }).spansLine;
		const fit = (s: string) => (visible(s).length > width ? cut(s, 0, width) : s);
		rows = paintDiff(
			[fit(`${bulletFor(status)} ${line(c.label ?? "")}`), ...(c.rows ?? []).map(r => fit(`  ${line(r)}`))],
			`${width}:${theme.isLight}`,
		);
	}
	replayCache.set(owner, { key, rows });
	return rows;
}

// ── Approval dialog, per Claude Code's permission frame: a rule in `permission` (top border
// only), the bold title, the call between dashed `subtle` rules, "Do you want to proceed?",
// numbered options (`❯` and the focused label in `suggestion`, dim `N.`), then `Esc to cancel`.
function claudeAnswer(label: string): string | undefined {
	if (label === "Approve" || label === "Approve Once") return "Yes";
	const session = /^Approve (.+) for this session$/.exec(label);
	if (session) return `Yes, and don’t ask again for any ${session[1]} command`;
	const grant = /^(?:Always )?Approve (?:Directory|File|Folder)?:?\s*(.+)$/.exec(label);
	if (grant) return `Yes, and always allow access to ${grant[1]} for this session`;
	if (label === "Deny") return "No, and tell omp what to do differently";
	if (label === "Deny and send message") return "No, and send your message";
	return undefined;
}

// Claude Code's titles by tool ("Allow tool: bash" in omp).
const TITLES: Record<string, string> = { bash: "Bash command", edit: "Edit file", ast_edit: "Edit file", write: "Create file", read: "Read file", fetch: "Fetch", eval: "Run code" };
const SUGGEST = (s: string) => `\x1b[38;2;${cc("suggestion")}m${s}\x1b[39m`;

// ── Ask form. omp frames the form in a box titled `Ask`, with `○`/`◉`/`☐` choice rows and
// a key-hint row. Claude Code draws a dim rule, numbered choices (`❯ 1. label`, the chosen
// one green with `✔`), `Type something.` for the free-text row and `Enter to select · …`.
const CHOICE = /^(\s*)(❯ |  )(○|◉|●|◯|☐|☑|☒|✓|\[ \]|\[x\]) (.*)$/u;
const MULTI: Record<string, true> = { "☐": true, "☑": true, "☒": true, "[ ]": true, "[x]": true };
const CHECKED: Record<string, true> = { "◉": true, "●": true, "☑": true, "☒": true, "✓": true, "[x]": true };
const KEY_NAMES: Record<string, string> = { "⏎": "Enter", "↵": "Enter", "⎋": "Esc", "⇥": "Tab", "␣": "Space", space: "Space" };
const HINT_VERBS: Record<string, string> = { choose: "select", next: "select", move: "navigate", "next field": "switch questions", note: "add notes" };

/** omp's `⏎ choose · ↑/↓ move · ⇥ next field · ⎋ cancel` → Claude Code's `Enter to select · …`. */
function askHints(text: string): string {
	return text
		.split(" · ")
		.flatMap(part => {
			if (part === "type your own") return [];
			const m = /^(\S+) (.+)$/.exec(part);
			if (!m) return [part];
			const keys = m[1].split("/").map(k => KEY_NAMES[k] ?? KEY_NAMES[k.toLowerCase()] ?? k).join("/");
			return [`${keys} to ${HINT_VERBS[m[2]] ?? m[2]}`];
		})
		.join(" · ");
}

const askRows = memo((rows, key) => {
	const width = Number(key.split(":")[1]) || 80;
	const top = /^╭─ (.+?) ─*╮$/.exec(plain(rows[0] ?? ""));
	if (!top) return rows;
	const out = [theme.fg("dim", "─".repeat(width))];
	// A custom title or a page indicator (`Ask · 1/2`) stays as the first line.
	const title = top[1].replace(/^Ask(?: · )?/, "");
	if (title) out.push(theme.bold(title));
	let n = 0;
	let hints: string | undefined;
	let divider = false;
	for (const row of rows.slice(1)) {
		const text = plain(row);
		if (/^╰─*╯$/.test(text)) continue;
		if (/^├─*┤$/.test(text)) {
			divider = true;
			continue;
		}
		const vis = visible(row);
		const bars = vis.flatMap(([, ch], i) => (ch === "│" ? [i] : []));
		// Frame rows are `│ content │`: one cell of padding each side.
		const inner = bars.length >= 2 && bars[0] === 0 ? cut(row, 2, bars[bars.length - 1] - 1) : row;
		const content = plain(inner).replace(/\s+$/, "");
		if (divider) {
			hints = content.trim();
			continue;
		}
		const choice = CHOICE.exec(content);
		if (!choice) {
			// Wrapped option labels continue on deeper-indented rows; anything else ends a group.
			if (!/^\s{4,}\S/.test(content)) n = 0;
			out.push(inner);
			continue;
		}
		const [, indent, cursor, mark, rest] = choice;
		n++;
		const focused = cursor.startsWith("❯");
		const multi = MULTI[mark] === true;
		const checked = CHECKED[mark] === true;
		const lead = `${indent}${focused ? SUGGEST("❯") : " "}${theme.fg("dim", ` ${n}.`)} ${multi ? `${checked ? "[✔]" : "[ ]"} ` : ""}`;
		const other = /^Other: ?/.exec(rest);
		if (other) {
			// The free-text row holds omp's live input (cursor included): keep its cells after the
			// label and rename the placeholder.
			const from = indent.length + cursor.length + mark.length + 1 + other[0].length;
			const value = cut(inner, from, width).replace("type your own", "Type something.");
			out.push(`${lead}${plain(value).trim() ? value : theme.fg("dim", "Type something.")}`);
			continue;
		}
		const body = focused ? SUGGEST(theme.bold(rest)) : checked && !multi ? theme.fg("success", `${rest} ✔`) : rest;
		out.push(`${lead}${body}`);
	}
	if (hints) {
		const line = askHints(hints);
		out.push("", theme.fg("dim", line.length > width ? `${line.slice(0, width - 1)}…` : line));
	}
	return out;
});

const approvalRows = memo((rows, key) => {
	const width = Number(key.split(":")[1]) || 80;
	const cursor = theme.nav.cursor;
	const permission = (s: string) => theme.fg("customMessageLabel", s);
	const head: string[] = [];
	const body: string[] = [];
	const options: string[] = [];
	let other: string[] = [];
	let n = 0;
	for (const row of rows) {
		const text = plain(row);
		const title = /^╭─ (?:Allow tool: )?(.+?) ─*╮?$/.exec(text);
		if (title && head.length === 0) {
			const name = title[1].replace(/\s*\(\d+s\)$/, "");
			head.push(permission("─".repeat(width)), ` ${theme.bold(permission(TITLES[name] ?? (name.includes(" ") ? name : "Tool use")))}`);
			continue;
		}
		if (/^[╰├][─┬┴┼]*[╯┤]?$/.test(text)) continue; // bottom border, divider
		// Content row: drop the side bars.
		const vis = visible(row);
		const bars = vis.flatMap(([, ch], i) => (ch === "│" ? [i] : []));
		const inner = bars.length >= 2 ? cut(row, bars[0] + 1, bars[bars.length - 1]) : row;
		const content = plain(inner).trim();
		const selected = content.startsWith(cursor);
		const answer = claudeAnswer(selected ? content.slice(cursor.length).trim() : content);
		if (answer) {
			n++;
			const esc = answer.startsWith("No, and tell") ? ` ${theme.bold("(esc)")}` : "";
			const label = selected ? SUGGEST(answer) : answer;
			options.push(`${selected ? SUGGEST(cursor) : " "} ${theme.fg("dim", `${n}.`)} ${label}${esc}`);
			continue;
		}
		if (!content) continue;
		// omp's key-hint row (after the options): Claude Code shows only "Esc to cancel".
		if (n > 0 && /\bselect\b|\bapprove\b|\bdeny\b/.test(content)) continue;
		// Claude Code's body shows the command itself, without omp's `Command:` label.
		(n > 0 ? other : body).push(` ${n > 0 ? content : content.replace(/^Command: /, "")}`);
	}
	if (!n) return rows;
	const dashed = theme.fg("dim", `╌`.repeat(width));
	other = other.filter(l => plain(l).trim());
	return [
		...head,
		...(body.length ? [dashed, ...body, dashed] : []),
		` Do you want to proceed?`,
		...options,
		...other,
		"",
		` ${theme.fg("dim", "Esc to cancel")}`,
	];
});

// ── Reply rows: the `✻ Thinking…` row, and no ``` fence rows (Claude Code shows the
// highlighted code without its fences).
const thinks = new WeakMap<object, boolean>();
// omp's own live row while hidden thinking streams: "<spinner> Thinking · 12 toks/s".
const LIVE_THINKING = /^\s*\S Thinking( · .*)?$/;
const FENCE = /^\s*(```|~~~)[\w+-]*\s*$/;
const withThinking = memo((rows, key) => {
	const kept = rows.filter(r => {
		const p = plain(r);
		return !LIVE_THINKING.test(p) && !FENCE.test(p);
	});
	let dotted = false;
	const body = kept.map(r => {
		if (plain(r).trim() === "") return r;
		if (dotted) return ` ${r}`;
		dotted = true;
		return `●${r}`;
	});
	if (!key) return body;
	const at = Math.max(0, body.findIndex(r => plain(r).trim() !== ""));
	const head = theme.italic(theme.fg("dim", "✻ Thinking…"));
	// Thinking only (tool calls follow): no gap row before the next block.
	return body.slice(at).length ? [...body.slice(0, at), head, "", ...body.slice(at)] : [...body, head];
});

// ── Spinner row, per Claude Code 2.1.322: `✻ Zesting… (12s · ↓ 1.2k tokens · thinking with high
// effort)`. Glyph and verb in `claude` with a 3-char `claudeShimmer` band; the parenthetical
// only once there are tokens, the turn passed 16 s, or the model is thinking. No
// "esc to interrupt" (Claude Code shows that only in its retry banner).
export const turn: { verb?: string; startedAt: number; tokens: number; phase: "requesting" | "responding" | "thinking"; thinkingSince: number; effort?: string } = {
	startedAt: 0,
	tokens: 0,
	phase: "requesting",
	thinkingSince: 0,
};

export function setTurnVerb(verb: string | undefined): void {
	turn.verb = verb;
	if (verb) {
		turn.startedAt = Date.now();
		turn.tokens = 0;
		turn.phase = "requesting";
	}
}

// Claude Code's spinner glyphs, played back and forth over 2 s, and its claudeShimmer color.
const FRAMES = ["·", "✢", "*", "✶", "✻", "✽"];

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function compactCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

// Claude Code's escalating thinking text.
function thinkingText(ms: number, effort: string | undefined): string {
	const s = ms / 1000;
	if (s >= 45) return "deep in thought";
	if (s >= 30) return "thinking some more";
	if (s >= 20) return "thinking more";
	if (s >= 10) return "still thinking";
	return effort && effort !== "off" ? `thinking with ${effort} effort` : "thinking";
}

function spinnerRows(width: number): Rows {
	const now = Date.now();
	const glyph = FRAMES[Math.round(((1 - Math.cos((2 * Math.PI * (now % 2000)) / 2000)) / 2) * (FRAMES.length - 1))];
	const verb = turn.verb ?? "Working…";
	// The band sweeps right to left at 200 ms/char (50 ms left to right while requesting), 10 cells of run-out.
	const span = verb.length + 10;
	const hot = turn.phase === "requesting" ? Math.floor(now / 50) % span : verb.length - 1 - (Math.floor(now / 200) % span);
	const text = [...verb]
		.map((ch, i) => (Math.abs(i - hot) <= 1 ? `\x1b[38;2;${cc("claudeShimmer")}m${ch}\x1b[39m` : theme.fg("accent", ch)))
		.join("");
	const ms = now - turn.startedAt;
	const parts: string[] = [];
	const thinking = turn.phase === "thinking";
	if (turn.tokens > 0 || ms > 16_000 || thinking) {
		parts.push(elapsed(ms));
		if (turn.tokens > 0) parts.push(`${turn.phase === "requesting" ? "↑" : "↓"} ${compactCount(turn.tokens)} tokens`);
		if (thinking) parts.push(thinkingText(now - turn.thinkingSince, turn.effort));
	}
	const tail = parts.length ? ` ${theme.fg("dim", `(${parts.join(" · ")})`)}` : "";
	const row = `${theme.fg("accent", glyph)} ${text}${tail}`;
	return ["", ANCHOR + (visible(row).length > width ? cut(row, 0, width) : row)];
}

type Tui = { requestRender(full?: boolean): void };

function repaintOnOverlayClose(proto: Proto): void {
	const full = (tui: Tui) => queueMicrotask(() => tui.requestRender(true));
	patch({ prototype: proto }, "hideOverlay", orig =>
		function (this: Tui, ...args: unknown[]) {
			const out = orig.apply(this, args);
			full(this);
			return out;
		},
	);
	patch({ prototype: proto }, "showOverlay", orig =>
		function (this: Tui, ...args: unknown[]) {
			const handle = orig.apply(this, args) as { hide?: () => void } | undefined;
			if (handle && typeof handle.hide === "function") {
				const hide = handle.hide;
				handle.hide = () => {
					hide();
					full(this);
				};
			}
			return handle;
		},
	);
}

// omp's `!cmd` box: a rule, ` $ cmd` (wrapped rows follow), a blank row, the output
// (1-column padding), a closing rule (` exit N ` in it on failure).
const isRule = (row: string) => /^─.*─$/.test(plain(row).trim());
const isBlank = (row: string) => !plain(row).trim();
const bangRows = memo((rows, key) => {
	const [w, done] = key.split(":");
	const width = Number(w);
	const head = rows.findIndex(r => !isRule(r) && /^\s*\$ /.test(plain(r)));
	if (head < 0) return rows;
	let cmdEnd = head + 1;
	while (cmdEnd < rows.length && !isBlank(rows[cmdEnd]) && !isRule(rows[cmdEnd])) cmdEnd++;
	const body = rows.slice(cmdEnd).filter(r => !isRule(r));
	while (body.length && isBlank(body[0])) body.shift();
	while (body.length && isBlank(body[body.length - 1])) body.pop();
	const cmd = rows[head].replace("$ ", "! ");
	const out = [dropLeadingChar(cmd, " ") ?? cmd, ...rows.slice(head + 1, cmdEnd).map(r => ` ${cut(r, 0, width - 1)}`)];
	const gutter = theme.fg("dim", "⎿  ");
	if (!body.length) out.push(`  ${gutter}${theme.fg("dim", done === "1" ? "(No output)" : "Running…")}`);
	body.forEach((r, i) => out.push(`${i ? "     " : `  ${gutter}`}${cut(r, 1, width - 4)}`));
	return out;
});

// ── Inline attachment labels. omp keeps a paste as a `📄 #1` atom in the prompt text (bold,
// colored); Claude Code shows `[Pasted text #1 +16 lines]`. Only the displayed segment changes,
// so a label that would not fit the prompt row keeps omp's short form (the editor wrapped the
// raw text; a wider row would overflow).
const CHIP_LABELS = Symbol.for("omp-claude-view.chipLabels");
const CHIP_KIND: Record<string, "paste" | "image" | "video"> = {
	"\u{1F4C4}": "paste",
	"\uF15C": "paste",
	txt: "paste",
	"\u{1F4F7}": "image",
	"\uF03E": "image",
	img: "image",
	"\u{1F3AC}": "video",
	"\uF008": "video",
	vid: "video",
};
const CHIP = /(?:\x1b\[[0-9;]*m)?\x1b\[1m(\u{1F4C4}|\uF15C|txt|\u{1F4F7}|\uF03E|img|\u{1F3AC}|\uF008|vid) #([1-9]\d*)\x1b\[22m\x1b\[39m/gu;

type Pending = { n: number; lineCount: number };

export function chipLabels(out: string, raw: string, editor: { pendingTexts?: unknown }): string {
	if (!out.includes("\x1b[1m")) return out;
	const texts = Array.isArray(editor.pendingTexts) ? (editor.pendingTexts as Pending[]) : [];
	let room = (process.stdout.columns || 80) - 3 - visible(raw).length;
	return out.replace(CHIP, (whole, sym: string, num: string) => {
		const n = Number(num);
		const kind = CHIP_KIND[sym];
		let label: string | undefined;
		if (kind === "paste") {
			const lines = texts.find(t => t.n === n)?.lineCount;
			if (lines === undefined) return whole;
			// Claude Code counts the newlines: 17 pasted lines read `+16 lines`.
			label = lines > 1 ? `[Pasted text #${n} +${lines - 1} lines]` : `[Pasted text #${n}]`;
		} else label = kind === "video" ? `[Video #${n}]` : `[Image #${n}]`;
		const grow = label.length - visible(`${sym} #${num}`).length;
		if (grow > room) return whole;
		room -= grow;
		return label;
	});
}

// ── Bottom-anchored prompt. A no-op SGR (default underline color) tags the first row of
// what belongs above the prompt (spinner, ponytail band), so the padding goes above them.
export const ANCHOR = "\x1b[59m";
type Frame = { viewport?: readonly string[] } & Record<string, unknown>;

function bottomAnchor(orig: (...args: unknown[]) => unknown) {
	return function (this: object, ...args: unknown[]) {
		const frame = orig.apply(this, args) as Frame;
		const size = args[0] as { columns?: number; rows?: number } | undefined;
		const rows = size?.rows ?? 0;
		const view = frame?.viewport;
		if (!view || !rows || view.length >= rows) return frame;
		let at = view.findIndex(r => r.startsWith(ANCHOR));
		if (at > 0 && plain(view[at - 1]).trim() === "") at--;
		if (at < 0) {
			// The prompt's top rule: the second-to-last full-width rule (the last closes the prompt).
			const rules = view.flatMap((r, i) => (/^─+$/.test(plain(r)) && plain(r).length === size?.columns ? [i] : []));
			at = rules.length >= 2 ? rules[rules.length - 2] : -1;
		}
		if (at < 0) return frame;
		return { ...frame, viewport: [...view.slice(0, at), ...new Array<string>(rows - view.length).fill(""), ...view.slice(at)] };
	};
}

// ── Diff rows with Claude Code's line backgrounds and changed-word highlight. omp strips
// escapes from compact rows, so rows carry private-use markers that the ToolExecutionComponent
// render patch (which knows the real width) turns into backgrounds padded to the full row.
const ADD = "\uF8F0";
const DEL = "\uF8F1";
const WORD_ON = "\uF8F2";
const WORD_OFF = "\uF8F3";
const MARKERS = new Set([ADD, DEL, WORD_ON, WORD_OFF]);

// ponytail: counts one cell per code point; wide (CJK/emoji) text in a diff pads short.
const paintDiff = memo((rows, key) => {
	const width = Number(key.split(":")[0]);
	const pal = { add: cc("diffAdded"), del: cc("diffRemoved"), addWord: cc("diffAddedWord"), delWord: cc("diffRemovedWord") };
	let changed = false;
	const out = rows.map(row => {
		const kind = row.includes(ADD) ? "add" : row.includes(DEL) ? "del" : undefined;
		if (!kind) return row;
		changed = true;
		const line = `\x1b[48;2;${pal[kind]}m`;
		const word = `\x1b[48;2;${pal[kind === "add" ? "addWord" : "delWord"]}m`;
		const cells = visible(row).filter(([, ch]) => !MARKERS.has(ch)).length;
		const painted = row
			.replace(kind === "add" ? ADD : DEL, line)
			.replace(WORD_ON, word)
			.replace(WORD_OFF, line);
		return `${painted}${" ".repeat(Math.max(0, width - cells))}\x1b[49m`;
	});
	return changed ? out : rows;
});

export type DiffLine = { sign: string; num: string; text: string };
type Span = { t: string; s?: string };

/** One compact row (spans) per diff line, `num sign text`, with background markers. */
export function diffRows(diff: DiffLine[]): Span[][] {
	const numW = Math.max(...diff.map(l => l.num.length), 1);
	// Pair the i-th removed line of a hunk with the i-th added line for word highlights.
	const partner = new Map<number, number>();
	for (let i = 0; i < diff.length; ) {
		let j = i;
		while (j < diff.length && diff[j].sign === "-") j++;
		let k = j;
		while (k < diff.length && diff[k].sign === "+") k++;
		for (let n = 0; n < Math.min(j - i, k - j); n++) {
			partner.set(i + n, j + n);
			partner.set(j + n, i + n);
		}
		i = Math.max(k, i + 1);
	}
	return diff.map((l, idx) => {
		const text = l.text.replace(/\t/g, "    ");
		const gutter: Span = { t: `${l.num.padStart(numW)} `, s: "dim" };
		if (l.sign !== "+" && l.sign !== "-") return [gutter, { t: ` ${text}` }];
		const other = partner.has(idx) ? diff[partner.get(idx)!].text.replace(/\t/g, "    ") : undefined;
		let pre = text.length;
		let suf = 0;
		if (other !== undefined) {
			pre = 0;
			while (pre < text.length && pre < other.length && text[pre] === other[pre]) pre++;
			while (suf < text.length - pre && suf < other.length - pre && text[text.length - 1 - suf] === other[other.length - 1 - suf]) suf++;
		}
		const mid = text.slice(pre, text.length - suf);
		const body = mid ? `${text.slice(0, pre)}${WORD_ON}${mid}${WORD_OFF}${text.slice(text.length - suf)}` : text;
		return [{ t: l.sign === "+" ? ADD : DEL }, gutter, { t: `${l.sign}${body}` }];
	});
}
