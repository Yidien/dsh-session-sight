/**
 * session-tools 薄壳 client —— 指令是根本，壳只做「按钮 → 触发命令」。
 *
 * 两个入口（侧栏底部）：
 *   🗑 删除会话  —— 活跃会话列表，每行「📦归档 / ♻彻底删除」
 *   📦 归档列表  —— 已归档会话列表，每行「↩取消归档 / ♻彻底删除」
 *
 * 设计（收敛结论）：
 *   - 砍掉「临时回收站」：官方「归档」= 隐藏但不动文件、可反悔，天然就是"临时删"；
 *   - 「彻底删除」= 进系统回收站（文件真正搬出 sessions 目录）；
 *   - 归档会话日志仍留在 sessions 下，侧栏靠官方 archivedSessionIds 集合过滤隐藏，
 *     所以无 projcache 残留、无"未分组"问题。
 *
 * 数据来源：
 *   - 活跃列表 = ctx.get("sessions").list 快照（标题 / updatedAt / 当前会话）
 *   - 归档列表 = host 的 GET /plugins/session-tools/state（archived 行）
 * 命令通道 = ctx.get("remote.commands").execute(sessionId, line)。
 * 零构建、零依赖：只用 react / react-dom/client。
 */
window.__ModuleLoader__.load({
	id: "session-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let reactDomClient = null;
		try {
			reactDomClient = require("react-dom/client");
		} catch {
			/* 极老 shell 无 react-dom/client 时只渲染按钮、不弹面板 */
		}
		let MarkdownText = null;
		try {
			MarkdownText = require("@deepseek-ai/dsh-client-ui-primitives").MarkdownText;
		} catch {
			/* primitives 不可用时预览退化为纯文本 */
		}

		/** client 端 cordis 服务：sessions、slots。 */
		const inject = ["sessions", "slots"];

		/**
		 * 入口定义。克制、低调：入口是单色线性小图标（title 悬停出文字），
		 * 动作是纯文字小标签；危险动作只用红色区分。
		 */
		const ENTRIES = [
			{
				key: "delete",
				label: "删除会话",
				icon: "trash",
				source: "active",
				hint: "选一个活跃会话：归档（可反悔）或彻底删除（进系统回收站）",
				rowActions: [
					{ key: "preview", label: "预览", command: null, danger: false },
					{ key: "archive", label: "归档", command: "/archive-session", danger: false },
					{ key: "recycle", label: "彻底删除", command: "/recycle-session", danger: true }
				]
			},
			{
				key: "archived",
				label: "归档列表",
				icon: "archive",
				source: "archived",
				hint: "已归档会话：预览 / 取消归档（回原位置）/ 彻底删除",
				rowActions: [
					{ key: "preview", label: "预览", command: null, danger: false },
					{ key: "unarchive", label: "取消归档", command: "/unarchive", danger: false },
					{ key: "recycle", label: "彻底删除", command: "/recycle-session", danger: true }
				]
			}
		];

		/** 低调的单色线性 SVG 图标（stroke=currentColor，随文字变灰/变亮）。 */
		const ICONS = {
			trash: react.createElement("svg", {
				viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"
			}, [
				react.createElement("path", { key: "p1", d: "M4 7h16" }),
				react.createElement("path", { key: "p2", d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }),
				react.createElement("path", { key: "p3", d: "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" }),
				react.createElement("path", { key: "p4", d: "M10 11v6M14 11v6" })
			]),
			archive: react.createElement("svg", {
				viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"
			}, [
				react.createElement("rect", { key: "r1", x: 3, y: 4, width: 18, height: 5, rx: 1 }),
				react.createElement("path", { key: "p1", d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }),
				react.createElement("path", { key: "p2", d: "M10 13h4" })
			])
		};

		const STATE_URL = "/plugins/session-tools/state";
		const PREVIEW_URL = "/plugins/session-tools/preview";

		/** 把一条斜杠命令行发给当前会话执行；失败只记 console，不打断 UI。 */
		function execute(ctx, line) {
			try {
				const current = ctx.get("sessions")?.list?.getSnapshot?.().current;
				if (current === undefined) {
					window.alert("当前没有打开的会话，请先打开一个会话再操作。");
					return;
				}
				const commands = ctx.get("remote.commands");
				const run = commands?.execute;
				if (typeof run !== "function") {
					window.alert("命令执行通道不可用（remote.commands 缺失）。");
					return;
				}
				Promise.resolve(run.call(commands, current, line)).catch((error) => {
					console.error("[session-tools] command execute failed:", error);
				});
			} catch (error) {
				console.error("[session-tools] thin-shell execute error:", error);
			}
		}

		function apply(ctx) {
			ENTRIES.forEach((entry, index) => {
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
					{ name: "sidebar.footer.action", id: `session-tools-${entry.key}`, order: 50000 + index, label: entry.label },
					(props) => react.createElement(
						"button",
						{
							type: "button",
							title: entry.label,
							"aria-label": entry.label,
							onClick: () => openPicker(ctx, entry),
							style: {
								border: "none",
								background: "transparent",
								color: "var(--dsw-alias-label-tertiary, #888)",
								cursor: "pointer",
								width: "28px",
								height: "28px",
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								padding: "0",
								borderRadius: "6px"
							},
							onMouseEnter: (event) => {
								event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))";
								event.currentTarget.style.color = "var(--dsw-alias-label-primary, #ccc)";
							},
							onMouseLeave: (event) => {
								event.currentTarget.style.background = "transparent";
								event.currentTarget.style.color = "var(--dsw-alias-label-tertiary, #888)";
							}
						},
						ICONS[entry.icon]
					)
				));
			});
		}

		/** 相对时间。 */
		function relativeTime(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
			const diff = Date.now() - ms;
			if (diff < 60 * 1000) return "刚刚";
			const minutes = Math.floor(diff / 60000);
			if (minutes < 60) return `${minutes} 分钟前`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours} 小时前`;
			const days = Math.floor(hours / 24);
			if (days < 30) return `${days} 天前`;
			try { return new Date(ms).toLocaleDateString(); } catch { return ""; }
		}

		/** 按入口取列表。 */
		async function resolveRows(ctx, entry) {
			if (entry.source === "active") {
				let snapshot;
				try {
					snapshot = ctx.get("sessions")?.list?.getSnapshot?.();
				} catch {
					snapshot = void 0;
				}
				const ids = Array.isArray(snapshot?.ids) ? snapshot.ids.slice() : [];
				const byId = snapshot?.byId ?? {};
				const current = snapshot?.current;
				return ids.map((id) => ({
					id,
					title: byId[id]?.displayTitle ?? id,
					time: byId[id]?.updatedAt ?? null,
					current: id === current
				}));
			}
			// source === "archived"
			let data;
			try {
				const res = await fetch(STATE_URL, { cache: "no-store" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				data = await res.json();
			} catch (error) {
				throw new Error("读不到归档列表：HTTP 查询失败（" + String(error?.message ?? error) + "）");
			}
			if (data?.archivedUnavailable === true) {
				throw new Error("归档集合不可用（workspace registry 未启动）");
			}
			const list = data?.archived;
			if (!Array.isArray(list)) throw new Error("返回数据格式不对");
			return list.map((row) => ({
				id: row.id,
				title: row.title ?? row.id,
				time: row.lastPromptAt ?? row.createdAt ?? null,
				current: false,
				extra: row.workspace ?? "",
				ghost: row.ghost === true
			}));
		}

		/** 面板：按入口列会话，每行一组动作按钮。单行两行内收拢。 */
		function openPicker(ctx, entry) {
			if (reactDomClient === null) {
				const raw = window.prompt(`${entry.label}：请输入会话 id，${entry.rowActions.map((a) => a.label).join("/")}`, "");
				if (raw === null || raw.trim() === "") return;
				const first = entry.rowActions[0];
				execute(ctx, `${first.command} ${raw.trim()}`);
				return;
			}

			const mount = document.createElement("div");
			let root = null;
			mount.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)";
			mount.addEventListener("mousedown", (event) => {
				if (event.target === mount) close();
			});
			const close = () => {
				try { root?.unmount(); } catch { /* 已卸载 */ }
				mount.remove();
			};
			root = reactDomClient.createRoot(mount);
			document.body.appendChild(mount);

			const dangerColor = "#e5484d";
			const hoverBg = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))";

			function Row({ row }) {
				const isCurrent = row.current === true;
				const disabled = isCurrent;
				return react.createElement("div", {
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "8px",
						padding: "7px 10px",
						borderRadius: "8px",
						border: isCurrent ? "1px solid rgba(78,140,255,.35)" : "1px solid transparent"
					}
				}, [
					react.createElement("div", {
						key: "info",
						style: { minWidth: 0, flex: 1, overflow: "hidden" }
					}, [
						react.createElement("span", {
							key: "t",
							style: {
								display: "flex",
								alignItems: "center",
								gap: "6px",
								overflow: "hidden",
								color: "var(--dsw-alias-label-primary, #eee)",
								fontSize: "13px"
							}
						}, [
							react.createElement("span", { key: "tt", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title),
							isCurrent ? react.createElement("span", { key: "c", style: { flexShrink: 0, color: "#6a9dff", fontSize: "11px" } }, "当前") : null
						]),
						react.createElement("span", {
							key: "m",
							style: {
								display: "block",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								color: "var(--dsw-alias-label-tertiary, #888)",
								fontSize: "11px",
								marginTop: "2px"
							}
						}, [relativeTime(row.time), row.extra].filter((s) => typeof s === "string" && s !== "").join(" · ") + (row.ghost ? " · 已失效的残留" : ""))
					]),
					react.createElement("div", { key: "acts", style: { flexShrink: 0, display: "flex", gap: "6px" } },
						entry.rowActions.map((act) => {
							const isPreview = act.command === null;
							const disabled = isCurrent && !isPreview;
							const previewColor = "#6a9dff";
							return react.createElement("button", {
								key: act.key,
								type: "button",
								disabled,
								title: isCurrent && !isPreview ? "当前会话不可这样操作" : act.label,
								onClick: disabled ? void 0 : () => {
									if (isPreview) {
										openPreviewPanel(ctx, row);
										return;
									}
									close();
									execute(ctx, `${act.command} ${row.id}`);
								},
								style: {
									border: isPreview
										? "1px solid rgba(106,157,255,.4)"
										: act.danger ? "1px solid rgba(229,72,77,.45)" : "1px solid var(--dsw-alias-border-l2, #333)",
									background: "transparent",
									color: isPreview ? previewColor : act.danger ? dangerColor : "var(--dsw-alias-label-primary, #eee)",
									cursor: disabled ? "default" : "pointer",
									opacity: disabled ? 0.45 : 1,
									fontSize: "12px",
									lineHeight: "18px",
									padding: "3px 10px",
									borderRadius: "999px",
									whiteSpace: "nowrap"
								},
								onMouseEnter: disabled ? void 0 : (event) => { event.currentTarget.style.background = isPreview ? "rgba(106,157,255,.12)" : act.danger ? "rgba(229,72,77,.1)" : hoverBg; },
								onMouseLeave: disabled ? void 0 : (event) => { event.currentTarget.style.background = "transparent"; }
							}, act.label);
						})
					)
				]);
			}

			function Panel() {
				const [state, setState] = react.useState({ loading: true, error: null, rows: [] });
				const [query, setQuery] = react.useState("");
				react.useEffect(() => {
					let alive = true;
					resolveRows(ctx, entry)
						.then((rows) => { if (alive) setState({ loading: false, error: null, rows }); })
						.catch((error) => { if (alive) setState({ loading: false, error: String(error?.message ?? error), rows: [] }); });
					return () => { alive = false; };
				}, []);

				const all = state.rows;
				const filtered = all.filter((row) => query.trim() === "" || row.title.toLowerCase().includes(query.trim().toLowerCase()) || row.id.toLowerCase().includes(query.trim().toLowerCase()));

				const listEl = react.createElement("div", { key: "list", style: { flex: 1, overflowY: "auto", padding: "0 8px 8px" } },
					state.loading
						? react.createElement("div", { style: { padding: "28px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" } }, "读取中…")
						: state.error !== null
							? react.createElement("div", { style: { padding: "28px", textAlign: "center", color: "#e08a8a", fontSize: "13px" } }, state.error)
							: all.length === 0
								? react.createElement("div", { style: { padding: "28px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" } }, "该列表是空的（没有会话）")
								: filtered.length === 0
									? react.createElement("div", { style: { padding: "28px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "13px" } }, "没有匹配的会话")
									: filtered.map((row) => react.createElement(Row, { key: row.id, row }))
				);

				return react.createElement("div", {
					role: "dialog",
					"aria-modal": "true",
					style: {
						width: "min(560px, calc(100vw - 40px))",
						maxHeight: "min(76vh, 600px)",
						display: "flex",
						flexDirection: "column",
						background: "var(--dsw-alias-bg-layer-2, #1e1e1e)",
						border: "1px solid var(--dsw-alias-border-l2, #333)",
						borderRadius: "14px",
						boxShadow: "0 16px 64px rgba(0,0,0,.45)",
						overflow: "hidden"
					},
					onMouseDown: (event) => event.stopPropagation()
				}, [
					react.createElement("div", {
						key: "head",
						style: { padding: "14px 16px 10px", display: "flex", alignItems: "baseline", gap: "8px" }
					}, [
						react.createElement("span", { key: "t", style: { color: "var(--dsw-alias-label-primary, #eee)", fontSize: "15px", fontWeight: 600 } }, entry.label),
						react.createElement("span", { key: "h", style: { color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "12px" } }, entry.hint ?? "")
					]),
					react.createElement("div", { key: "search", style: { padding: "0 16px 10px" } },
						react.createElement("input", {
							type: "text",
							autoFocus: true,
							placeholder: "搜索标题或 id…（共 " + all.length + " 个）",
							value: query,
							onChange: (event) => setQuery(event.target.value),
							style: {
								width: "100%",
								boxSizing: "border-box",
								border: "1px solid var(--dsw-alias-border-l2, #333)",
								borderRadius: "8px",
								background: "var(--dsw-alias-bg-layer-1, #171717)",
								color: "var(--dsw-alias-label-primary, #eee)",
								padding: "7px 10px",
								fontSize: "13px",
								outline: "none"
							}
						})
					),
					listEl
				]);
			}

			root.render(react.createElement(Panel));
		}

		/** 拉取一条会话的只读预览（最近消息）。 */
		async function fetchPreview(id) {
			const res = await fetch(`${PREVIEW_URL}?id=${encodeURIComponent(id)}`, { cache: "no-store" });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
			return data;
		}

		/** 只读预览面板：气泡式展示一条会话最近几条 user/assistant 消息。克制、无图标。 */
		function openPreviewPanel(ctx, row) {
			const mount = document.createElement("div");
			let root = null;
			mount.style.cssText = "position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)";
			mount.addEventListener("mousedown", (event) => {
				if (event.target === mount) close();
			});
			const close = () => {
				try { root?.unmount(); } catch { /* 已卸载 */ }
				mount.remove();
			};
			root = reactDomClient.createRoot(mount);
			document.body.appendChild(mount);

			function Preview() {
				const [state, setState] = react.useState({ loading: true, error: null, data: null });
				react.useEffect(() => {
					let alive = true;
					fetchPreview(row.id)
						.then((data) => { if (alive) setState({ loading: false, error: null, data }); })
						.catch((error) => { if (alive) setState({ loading: false, error: String(error?.message ?? error), data: null }); });
					return () => { alive = false; };
				}, []);

				const msgs = state.data?.messages ?? [];
				const body = state.loading
					? react.createElement("div", { style: { padding: "32px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)" } }, "读取中…")
					: state.error !== null
						? react.createElement("div", { style: { padding: "32px", textAlign: "center", color: "#d99" } }, state.error)
						: msgs.length === 0
							? react.createElement("div", { style: { padding: "32px", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #999)" } }, "这个会话没有可预览的对话内容。")
							: msgs.map((m, i) => {
								const isUser = m.type === "user/message";
								const content = MarkdownText !== null
									? react.createElement(MarkdownText, { text: m.text })
									: m.text;
								return react.createElement("div", {
									key: i,
									style: { margin: "0 0 14px", display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }
								}, [
									react.createElement("div", {
										key: "who",
										style: {
											fontSize: "11px",
											color: isUser ? "var(--dsw-alias-label-tertiary, #888)" : "#6a9dff",
											margin: "0 6px 4px"
										}
									}, isUser ? "你" : "助手"),
									react.createElement("div", {
										key: "bubble",
										style: {
											maxWidth: "92%",
											padding: "10px 14px",
											borderRadius: "14px",
											background: isUser
												? "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))"
												: "var(--dsw-alias-bg-layer-1, #171717)",
											border: isUser ? "none" : "1px solid var(--dsw-alias-border-l2, #2f2f2f)",
											color: "var(--dsw-alias-label-primary, #eee)",
											fontSize: "14px",
											lineHeight: "22px",
											wordBreak: "break-word"
										}
									}, content)
								]);
							});

				return react.createElement("div", {
					role: "dialog",
					"aria-modal": "true",
					style: {
						width: "min(620px, calc(100vw - 40px))",
						maxHeight: "min(80vh, 680px)",
						display: "flex",
						flexDirection: "column",
						background: "var(--dsw-alias-bg-layer-2, #1e1e1e)",
						border: "1px solid var(--dsw-alias-border-l2, #333)",
						borderRadius: "14px",
						boxShadow: "0 16px 64px rgba(0,0,0,.45)",
						overflow: "hidden"
					},
					onMouseDown: (event) => event.stopPropagation()
				}, [
					react.createElement("div", {
						key: "head",
						style: { padding: "12px 16px", display: "flex", alignItems: "center", gap: "10px", borderBottom: "1px solid var(--dsw-alias-border-l2, #333)" }
					}, [
						react.createElement("span", { key: "t", style: { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary, #eee)", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title),
						react.createElement("span", { key: "sub", style: { flexShrink: 0, color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "11px" } }, "最近 " + msgs.length + " 条"),
						react.createElement("button", {
							key: "x",
							type: "button",
							onClick: close,
							title: "关闭",
							style: { border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary, #999)", cursor: "pointer", fontSize: "14px", padding: "2px 6px", borderRadius: "6px" },
							onMouseEnter: (event) => { event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))"; },
							onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; }
						}, "关闭")
					]),
					react.createElement("div", { key: "body", style: { flex: 1, overflowY: "auto", padding: "14px 16px" } }, body)
				]);
			}

			root.render(react.createElement(Preview));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
