/**
* session-tools — 会话回收站 + 归档管理工具（外挂插件，零依赖）。
*
* 八个命令：
*   /delete-session <id|标题>   一级删：把会话目录移入 ~/.dsh/.trash（可恢复）+ 摘 workspace 账目
*   /restore-session <id|标题>  从 ~/.dsh/.trash 移回会话目录
*   /recycle-session <id|标题>  二级删：把会话目录移入系统回收站 + 彻底清 projcache/workspace
*   /trash                      列出回收站内容
*   /empty-trash                清空 ~/.dsh/.trash（物理删除）
*   /clean-orphans              清理残留孤儿：projcache 有记录但磁盘日志目录已不存在
*   /archived                   列出归档会话（补官方缺失的归档查看入口）
*   /unarchive <id|标题>        取消归档，回原工作区
*
* 设计要点：
*  - 不依赖任何 @deepseek-ai/* 包（只用 node 内置模块 + ctx 服务），升级 dsh 不受影响；
*  - 清脏走官方 workspaceRegistry（detachSession / setState）与 storageDomain（session_projcache 行），
*    不用改 json 文件——服务端 write-behind flush 会覆盖文件改动；
*  - 取消归档走与官方 archiveSession 相同的 setState 写路径，前端侧边栏实时更新；
*  - 方案 B：删除后调 registry.replaceHeaderIndex(list()) + indexLiveSessions() 重建内存索引，
*    清掉已删 id 的撞车残留（官方索引只增不减），免重启即时修复；
*  - 拒绝删除运行中/当前会话。
*/
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const execFileAsync = promisify(execFile);

const name = "session-tools";
const inject = ["commands"];

/** DSH_HOME 优先，回退到用户主目录 .dsh。 */
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function sessionsRoot() {
	return join(dshHome(), "sessions");
}
function trashRoot() {
	return join(dshHome(), ".trash");
}
function projcachePath() {
	return join(dshHome(), "storages", "session_projcache.json");
}
/** 双 id 拼写：原始 uuid 与 `session-` 前缀。不同存储可能用任一拼写。 */
function sessionIdVariants(sessionId) {
	const variants = new Set([sessionId]);
	if (sessionId.startsWith("session-")) variants.add(sessionId.slice("session-".length));
	else variants.add(`session-${sessionId}`);
	return [...variants];
}
/**
* 读官方 workspace registry（ctx.get("workspaceRegistry")，即 ctx.workspaceRegistry）。
* 归档集与工作区账目的权威都在它身上：archivedSessionIds / state / setState / list()。
* 服务可能未绑定（headless profile），返回 undefined；调用方据此降级。
*/
function getWorkspaceRegistry(ctx) {
	return ctx.get("workspaceRegistry");
}

/**
* 用官方接口清脏：
*  - projcache 行：走 storageDomain 内存域的 session_projcache 表删行（不 import 官方 spec，零依赖）；
*  - workspace 账目：逐一 workspace.detachSession(id)（内部 table.update，正确清 sessionIds 归属）；
*  - 归档集合：registry.setState({ ...state, archivedSessionIds: next })——与官方 archiveSession 同一写路径，
*    会自动触发 domain/changed → host/archived-sessions-changed 推送到前端侧边栏。
* 完全避开"改 json 文件会被 write-behind flush 覆盖"的坑。
*/
async function stripStorageDomains(ctx, sessionId, { workspace = true, projcache = true, archived = true } = {}) {
	const variants = sessionIdVariants(sessionId);
	let projRemoved = false;
	let workspaceRemoved = false;
	let archivedRemoved = false;
	if (projcache) {
		const proj = ctx.get("storageDomain")?.get?.("session_projcache");
		if (proj && typeof proj.table === "function") {
			try {
				const sessions = proj.table("sessions");
				for (const variant of variants) {
					if (sessions.get(variant) !== undefined) {
						await sessions.delete(variant);
						projRemoved = true;
					}
				}
			} catch { /* 域已关闭或表缺失：无可清理 */ }
		}
	}
	if (workspace || archived) {
		const registry = getWorkspaceRegistry(ctx);
		if (workspace) {
			try {
				for (const entity of registry?.list?.() ?? []) {
					const ids = entity?.sessionIds ?? [];
					// detach 需要列表里真实存在的那种拼写（detachSession 内部做严格 includes 比较）。
					const matched = Array.isArray(ids)
						? ids.find((id) => variants.includes(String(id)))
						: void 0;
					if (matched !== void 0) {
						await entity.detachSession(matched);
						workspaceRemoved = true;
					}
				}
			} catch { /* 注册表缺失/未启动：跳过工作区账目清理 */ }
		}
		if (archived) {
			try {
				const state = registry?.state;
				const current = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds.map(String) : [];
				if (variants.some((v) => current.includes(v))) {
					const next = current.filter((id) => !variants.includes(id));
					await registry.setState({ ...state, archivedSessionIds: next });
					archivedRemoved = true;
				}
			} catch { /* 注册表缺失/无 setState（老构建）：跳过归档集合清理 */ }
		}
	}
	return { projRemoved, workspaceRemoved, archivedRemoved };
}
/**
* 方案 B：删除后重建 workspace registry 的内存 header 索引，清掉"撞车残留"。
*
* 背景：官方 WorkspaceRegistry 的 headers/sessionPaths/invalidSessionPaths 三个
* Map 是「只增不减」的（indexHeader 只 set 不删）。外挂清不掉它们（私有字段），
* 若某 id 曾被索引过、之后又被删除，同 id 再重建新会话时（冷复用撞车），
* sessionKnown 会在 this.headers.has(id) 短路、把新会话当旧会话看（识别错 cwd/标题）。
*
* 官方唯一会 headers.clear() 的公开入口是 replaceHeaderIndex(headers)，但它只在
* 启动 [Service.init] 时被调一次。这里照官方的启动顺序主动触发：
*   replaceHeaderIndex(磁盘真实 list())  →  indexLiveSessions() 补回内存 live 会话。
* 两步必须在同一段代码内连续调用（live 会话经 indexLiveSessions 从 ctx.sessions
* 捞回索引，绝不会丢）；对正在沟通的会话无影响——它不碰 sessions/持久化/agent 链路。
*
* 纯 ctx.get 官方公开接口，零依赖；feature-detect 缺失时安全跳过（旧构建/headless）。
*/
async function rebuildRegistryIndex(ctx) {
	try {
		const registry = getWorkspaceRegistry(ctx);
		const persistence = ctx.get("sessionPersistence");
		if (!registry || typeof registry.replaceHeaderIndex !== "function") return { rebuilt: false };
		if (!persistence || typeof persistence.list !== "function") return { rebuilt: false };
		await registry.replaceHeaderIndex(await persistence.list());
		if (typeof registry.indexLiveSessions === "function") await registry.indexLiveSessions();
		return { rebuilt: true };
	} catch {
		return { rebuilt: false };
	}
}
/**
* 判断一个会话是否在磁盘上还有日志目录（含双 id 拼写）。
* 若两种拼写都找不到目录，说明是残留孤儿（应清账）。
*/
async function hasSessionDirOnDisk(sessionId) {
	const root = sessionsRoot();
	const variants = sessionIdVariants(sessionId);
	try {
		const projects = await readdir(root, { withFileTypes: true });
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			for (const variant of variants) {
				try {
					const entries = await readdir(join(root, project.name, variant));
					if (entries.some((e) => e.startsWith("session.jsonl"))) return true;
				} catch { /* 无此目录，继续 */ }
			}
		}
	} catch { /* sessions 根缺失 */ }
	return false;
}
/** 从投影缓存读会话元信息（标题 / 最后活跃时间 / 创建时间）。只读、尽力而为。 */
function sessionMetaFromProjcache() {
	const out = /* @__PURE__ */ new Map();
	try {
		const j = JSON.parse(readFileSync(projcachePath(), "utf8"));
		for (const [id, row] of Object.entries(j?.tables?.sessions ?? {})) {
			const title = row?.rows?.title?.val;
			const lastPromptAt = row?.rows?.sessionListMetadata?.val?.lastPromptAt;
			const createdAt = row?.identity?.createdAt;
			out.set(String(id), {
				title: typeof title === "string" ? title : void 0,
				lastPromptAt: typeof lastPromptAt === "number" ? lastPromptAt : void 0,
				createdAt: typeof createdAt === "number" ? createdAt : void 0
			});
		}
	} catch {
		/* 投影缓存缺失/损坏时元信息为空，命令仍可凭 id 使用 */
	}
	return out;
}
/** 从投影缓存读标题（只读、尽力而为；缓存里没有就返回空）。 */
function titlesFromProjcache() {
	const out = /* @__PURE__ */ new Map();
	for (const [id, meta] of sessionMetaFromProjcache()) {
		if (meta.title !== void 0) out.set(id, meta.title);
	}
	return out;
}
/** 递归找 `<root>/<project>/<id>/session.jsonl*`（深度 2，容错兜底）。 */
async function scanForLog(root, id) {
	const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const sessionDir = join(root, project.name, id);
		try {
			const entries = await readdir(sessionDir);
			if (entries.some((e) => e.startsWith("session.jsonl"))) return join(sessionDir, entries.find((e) => e.startsWith("session.jsonl")));
		} catch {
			/* 无此会话目录，继续 */
		}
	}
	return void 0;
}
/**
* 定位一个会话的目录。返回 { sessionDir, projectDir }；找不到返回 null。
* 优先用持久化服务的 locate()（处理路径编码），失败再递归扫盘。
*/
async function locateSession(ctx, id) {
	const persistence = ctx.get("sessionPersistence");
	let logPath;
	try {
		const headers = await persistence.list();
		const header = headers.find((h) => String(h.id) === id);
		if (header === void 0) return null;
		const loc = persistence.locate?.({ id, cwd: header.cwd });
		logPath = loc?.path;
	} catch {
		logPath = void 0;
	}
	if (logPath === void 0) {
		const root = persistence.root ?? sessionsRoot();
		logPath = await scanForLog(root, id);
	}
	if (logPath === void 0) return null;
	return { sessionDir: dirname(logPath), projectDir: dirname(dirname(logPath)) };
}
/** 把参数解析成会话 id：先按 id 精确匹配，再按标题/前缀唯一匹配。 */
function resolveSessionId(arg, ids, titles) {
	if (ids.has(arg)) return arg;
	const matches = [...ids].filter((id) => id.includes(arg) || String(titles.get(id) ?? "").includes(arg));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) return null;
	return matches;
}
function candidateText(ids, titles) {
	return ids.map((id) => `  ${id}  "${titles.get(id) ?? "(无标题)"}"`).join("\n");
}
/**
* 读官方归档集合（durable state 的 archivedSessionIds）。
* 未绑 workspaceRegistry 时返回 undefined；无字段时返回空数组。
*/
function readArchivedIds(ctx) {
	try {
		const registry = getWorkspaceRegistry(ctx);
		if (!registry || !Array.isArray(registry.archivedSessionIds)) return void 0;
		return registry.archivedSessionIds.map(String);
	} catch {
		return void 0;
	}
}
/**
* 组装 /archived 的展示数据：每个归档 id 附带
* 标题（投影缓存优先，回退 projcache.json 文件）、所属工作区、创建时间、是否幽灵行。
* 全部只读、尽力而为——任何一步缺失都不影响其余行。
* 幽灵行判定（借鉴 wsxwj123/dsh-session-manager §2.2）：归档集合里 byId 已不存在的 dangling id，
* 在标题/工作区/磁盘三处都没有痕迹 → 标 ghost:true，由展示层降级提示（不隐藏，防"数据黑洞"变"消失黑洞"）。
*/
function buildArchivedRows(ctx, archivedIds, titles) {
	const registry = getWorkspaceRegistry(ctx);
	// 工作区账目：sessionIds -> 工作区标题。official record 里归档会话保留了 sessionIds 位置（unarchive 要还原位置）。
	const workspaceOf = new Map();
	const hasSessionSlot = new Set();
	try {
		for (const entity of registry?.list?.() ?? []) {
			for (const sid of entity?.sessionIds ?? []) {
				hasSessionSlot.add(String(sid));
				if (!workspaceOf.has(String(sid))) workspaceOf.set(String(sid), entity.title ?? basename(entity.path ?? ""));
			}
		}
	} catch {
		/* registry 缺失时工作区/归属为空 */
	}
	// 标题优先取投影缓存；缓存缺失时回落读磁盘 projcache.json（恢复/归档后的会话仍在缓存里）。
	const titlesFromProjcacheFile = titlesFromProjcache();
	const metaById = sessionMetaFromProjcache();
	// 已知会话集合（persistence 的 header 索引）——用于幽灵行判定。
	const knownIds = new Set();
	const createdAtOf = new Map();
	try {
		for (const h of ctx.get("sessionPersistence")?.list?.() ?? []) {
			if (typeof h?.id === "string") {
				knownIds.add(String(h.id));
				if (h.createdAt !== void 0) createdAtOf.set(String(h.id), h.createdAt);
			}
		}
	} catch {
		/* persistence 缺失时：不判定幽灵行（knownIds 为空则一律视为非幽灵），创建时间为空 */
	}
	return archivedIds.map((id) => {
		const v = sessionIdVariants(id);
		let title;
		for (const variant of v) {
			title = titles.get(variant) ?? titlesFromProjcacheFile.get(variant);
			if (title !== void 0) break;
		}
		let lastPromptAt;
		for (const variant of v) {
			lastPromptAt = metaById.get(variant)?.lastPromptAt;
			if (lastPromptAt !== void 0) break;
		}
		let workspace;
		let inSessionIds = false;
		for (const variant of v) {
			workspace = workspaceOf.get(variant);
			inSessionIds = hasSessionSlot.has(variant);
			if (workspace !== void 0 || inSessionIds) break;
		}
		// 幽灵行：会话既不在任何工作区账目，标题也查不到，且不在 header 索引——但仍在归档集合里。
		// knownIds 为空（persistence 读失败/缺失）时不判定为幽灵，避免误报。
		const known = v.some((variant) => knownIds.has(variant));
		const ghost = knownIds.size > 0 && !inSessionIds && title === void 0 && !known;
		return {
			id,
			title: title ?? null,
			workspace: workspace ?? null,
			inSessionIds,
			ghost,
			lastPromptAt: lastPromptAt ?? null,
			createdAt: createdAtOf.get(id) ?? null
		};
	});
}
/** 把归档行格式化成可读文本。 */
function formatArchivedRows(rows) {
	return rows.map((row) => {
		const ghost = row.ghost ? "  ⚠ 幽灵行（会话已不存在，仅归档集合残留；可用 /unarchive 清掉）" : "";
		const title = typeof row.title === "string" && row.title.trim() !== "" ? `"${row.title}"` : "(无标题)";
		const workspace = row.workspace ? `  工作区  ${row.workspace}` : "";
		const position = row.inSessionIds ? "  [在分区，可还原位置]" : "  [无分区]";
		const createdAt = typeof row.createdAt === "string" || typeof row.createdAt === "number"
			? `  ${new Date(row.createdAt).toLocaleString()}`
			: "";
		return `  ${row.id}  ${title}${workspace}${position}${createdAt}${ghost}`;
	}).join("\n");
}
/**
* 取消归档：从官方 archivedSessionIds 移除该 id。
* 走 registry.setState（与 archiveSession 同一写路径），前端会实时收到
* host/archived-sessions-changed 事件、会话回到原分区（sessionIds 位置一直保留着）。
* 语义（借鉴 wsxwj123/dsh-session-manager）：
*  - 读失败（state 未启动/缺字段）= 可重试错误，绝不当成"空集合"去写（防 clobber 掉 workspaceIds/initialized）；
*  - id 本就不在集合 = 幂等 no-op，不报错。
* 不 import 任何 @deepseek-ai 包，仅用官方服务暴露的公开字段。
*/
async function unarchiveSession(ctx, id) {
	const registry = getWorkspaceRegistry(ctx);
	if (!registry || typeof registry.setState !== "function") {
		return { kind: "error", text: "当前 dsh 构建没有 workspace registry 状态写入口，无法取消归档。" };
	}
	let state;
	try {
		state = registry.state;
	} catch {
		return { kind: "error", text: "workspace 状态读取失败（registry 未启动），请稍后重试。" };
	}
	const current = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds.map(String) : [];
	const variants = sessionIdVariants(id);
	if (!variants.some((v) => current.includes(v))) {
		// 幂等 no-op：本就不在归档集合，无需写。
		return { kind: "success", text: `会话 ${id} 本就不在归档集合里，无需操作。` };
	}
	const next = current.filter((sid) => !variants.includes(sid));
	await registry.setState({ ...state, archivedSessionIds: next });
	return { kind: "success", text: `已取消归档会话 ${id}，它会回到原工作区列表。` };
}
/**
 * 归档一个活跃会话：走官方 archiveSession（隐藏但不动日志、不动 sessionIds 席位，
 * 取消归档可还原位）。幂等：已归档直接成功。不 import 官方包，只调公开方法。
 */
async function archiveSessionById(ctx, id) {
	const registry = getWorkspaceRegistry(ctx);
	if (!registry || typeof registry.archiveSession !== "function") {
		return { kind: "error", text: "当前 dsh 构建没有归档入口（archiveSession 缺失）。" };
	}
	try {
		await registry.archiveSession(id);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (/unknown/i.test(msg)) return { kind: "error", text: `找不到会话 ${id}，无法归档。` };
		return { kind: "error", text: `归档失败：${msg}` };
	}
	return { kind: "success", text: `已归档会话 ${id}。它从分组视图消失，日志与位置保留，可用「归档列表 → 取消归档」还原。` };
}
/** 实时/当前会话禁止删除。 */
function refuseLive(ctx, invocation, id) {
	if (ctx.get("sessions")?.get(id) !== void 0) return `会话 ${id} 正在运行，不能删除。`;
	if (invocation.agent?.session?.id === id) return "不能删除当前正在使用的会话。";
	return null;
}
/** 把会话目录移入回收站（保留 <项目目录>/<会话id> 结构，便于原路恢复）。 */
async function trashSession(ctx, invocation, id, titles) {
	const live = refuseLive(ctx, invocation, id);
	if (live !== null) return { kind: "error", text: live };
	const located = await locateSession(ctx, id);
	if (located === null) return { kind: "error", text: `找不到会话 ${id}（可能已删除或不存在）。` };
	const project = basename(located.projectDir);
	const dest = join(trashRoot(), project, id);
	await mkdir(dirname(dest), { recursive: true });
	await rename(located.sessionDir, dest);
	// 一级删=可恢复，只摘 workspace 账目（从列表/分组消失），保留 projcache 供恢复读标题。
	try { await stripStorageDomains(ctx, id, { projcache: false }); } catch { /* 账目清理失败不阻塞删除 */ }
	// 方案 B：重建 registry 内存索引，清掉已删 id 的撞车残留（免重启）。
	try { await rebuildRegistryIndex(ctx); } catch { /* 索引重建失败不阻塞删除（重启会兜底） */ }
	return {
		kind: "success",
		text: `已把会话 ${id}（"${titles.get(id) ?? "无标题"}"）移入回收站 ${dest}\n可用 /restore-session ${id} 恢复。`
	};
}
/** 从回收站按 <项目目录>/<会话id> 移回。 */
async function restoreSession(ctx, id, titles) {
	const projects = await readdir(trashRoot(), { withFileTypes: true }).catch(() => []);
	let source;
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const candidate = join(trashRoot(), project.name, id);
		if (await stat(candidate).then(() => true, () => false)) {
			source = { dir: candidate, project: project.name };
			break;
		}
	}
	if (source === void 0) return { kind: "error", text: `回收站里没有 ${id}。` };
	const dest = join(sessionsRoot(), source.project, id);
	// 借鉴 wsxwj123：原位置已有目录时拒绝恢复，绝不覆盖（rename 对非空目标会失败，这里给出清晰语义）。
	if (await stat(dest).then(() => true, () => false)) {
		return { kind: "error", text: `恢复目标已存在 ${dest}，拒绝覆盖。请先处理该目录，或改用 /recycle-session 清掉回收站副本。` };
	}
	await mkdir(dirname(dest), { recursive: true });
	await rename(source.dir, dest);
	return { kind: "success", text: `已把会话 ${id}（"${titles.get(id) ?? "无标题"}"）恢复到 ${dest}。` };
}
/** 列出回收站。 */
async function listTrash(titles) {
	const projects = await readdir(trashRoot(), { withFileTypes: true }).catch(() => []);
	const rows = [];
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = join(trashRoot(), project.name);
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) rows.push({ id: entry.name, project: project.name });
		}
	}
	if (rows.length === 0) return { kind: "success", text: "回收站是空的。" };
	return {
		kind: "success",
		text: `回收站（${rows.length} 个会话）：\n${rows.map((row) => `  ${row.id}  "${titles.get(row.id) ?? "（回收后标题未索引）"}"  ← ${row.project}`).join("\n")}`
	};
}
/** 通过 Windows 回收站删除一个目录（可在资源管理器恢复；没有程序化恢复接口）。 */
async function sendToRecycleBin(target) {
	const script = "Add-Type -AssemblyName Microsoft.VisualBasic;" +
		`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${target.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
	await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}

// ── HTTP 查询面（浏览器壳拿「回收站/归档」两份名单用）─────────────────────────
// 浏览器端的 sessions 服务只有「活跃会话」快照，拿不到回收站/归档名单；这里挂一个
// 只读 GET，让每个按钮按自己的定位取对应列表。懒绑定姿势与 dsh-archived-chats 一致。

const WEB_SERVER_KEYS = ["webServer", "httpServer"];
const STATE_ROUTE_PATH = "/plugins/session-tools/state";

/** 发送一个 JSON 响应。 */
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}

/** 按双 id 拼写从元信息表取一条（原始 uuid / session- 前缀）。 */
function metaFor(meta, id) {
	for (const variant of sessionIdVariants(id)) {
		const m = meta.get(variant);
		if (m !== void 0) return m;
	}
	return void 0;
}

/** 结构化列出回收站：每行附标题 / 最后活跃时间 / 创建时间 / 所属项目目录。 */
async function listTrashRows() {
	const meta = sessionMetaFromProjcache();
	const projects = await readdir(trashRoot(), { withFileTypes: true }).catch(() => []);
	const rows = [];
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = join(trashRoot(), project.name);
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isDirectory()) continue;
			const id = entry.name;
			const m = metaFor(meta, id);
			rows.push({
				id,
				project: project.name,
				title: m?.title ?? null,
				lastPromptAt: m?.lastPromptAt ?? null,
				createdAt: m?.createdAt ?? null
			});
		}
	}
	return rows;
}

/** 组装归档行供 HTTP 路由返回；registry 未启动时返回 null（前端降级为“不可用”）。 */
function archivedRowsForRoute(ctx, titles) {
	const archivedIds = readArchivedIds(ctx);
	if (archivedIds === void 0) return null;
	if (archivedIds.length === 0) return [];
	return buildArchivedRows(ctx, archivedIds, titles);
}

/** 注册 /plugins/session-tools/state：一次性把回收站 + 归档名单返回给浏览器壳。 */
function registerStateRoute(ctx, webServer) {
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: STATE_ROUTE_PATH,
		handler: async (_req, res) => {
			try {
				const titles = titlesFromProjcache();
				const trash = await listTrashRows();
				const archived = archivedRowsForRoute(ctx, titles);
				sendJson(res, 200, {
					trash,
					archived: archived ?? [],
					archivedUnavailable: archived === null
				});
			} catch (error) {
				sendJson(res, 500, { error: "state-failed", message: String(error?.message ?? error) });
			}
		}
	}), "session-tools: state route");
}

// ── 会话内容只读预览（回收站 / 归档）─────────────────────────────────────────
// 日志是「拼接 zstd 帧 + JSONL」容器（dsh-session-persistence-jsonl 的物理编码）。
// 不 import 官方包（零依赖），用扫描帧魔数 + Node 内置 zlib.zstdDecompressSync 逐帧解压。

const PREVIEW_ROUTE_PATH = "/plugins/session-tools/preview";

/** 把拼接 zstd 帧的 Buffer 解码成 JSONL 文本；逐帧定位、逐帧解压，尽力而为。 */
function decodeZstdFrames(buf) {
	const frames = [];
	// 帧魔数 0x28 0xB5 0x2F 0xFD（大端字节序，逐字节比较，不能用 readUInt32LE）。
	for (let i = 0; i < buf.length - 4; i++) {
		if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) frames.push(i);
	}
	if (frames.length === 0) {
		// 无帧边界（极小/单帧文件）：整体解一次。
		try { return zstdDecompressSync(buf).toString("utf8"); } catch { return ""; }
	}
	let out = "";
	for (let k = 0; k < frames.length; k++) {
		const start = frames[k];
		const end = k + 1 < frames.length ? frames[k + 1] : buf.length;
		try {
			out += zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
		} catch { /* 单帧损坏/torn 尾帧：跳过，不影响已解出的正文 */ }
	}
	return out;
}

/** 从一行 JSONL 事件里提取「给人看」的文本；非消息类返回 null。 */
function messageTextOf(event) {
	const type = event?.type;
	if (type !== "user/message" && type !== "assistant/message") return null;
	const content = event?.data?.content;
	if (Array.isArray(content)) {
		const parts = content
			.filter((c) => c && c.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		if (parts.length > 0) return parts.join("\n");
	}
	if (typeof content === "string") return content;
	return null;
}

/**
 * 找一条会话日志文件（回收站优先、再回 sessions 目录），返回其绝对路径。
 * 双 id 拼写都试；找不到返回 null。
 */
async function findLogPath(id) {
	const variants = sessionIdVariants(id);
	for (const root of [trashRoot(), sessionsRoot()]) {
		const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			for (const variant of variants) {
				const dir = join(root, project.name, variant);
				const entries = await readdir(dir).catch(() => []);
				const log = entries.find((e) => e.startsWith("session.jsonl"));
				if (log !== void 0) return join(dir, log);
			}
		}
	}
	return null;
}

/** 读取最近 N 条 user/assistant 消息（倒序取尾部，正序返回），供只读预览。 */
function recentMessagesFromText(text, maxMessages = 20) {
	const messages = [];
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
		if (lines[i] === "") continue;
		let ev;
		try { ev = JSON.parse(lines[i]); } catch { continue; }
		const textPart = messageTextOf(ev);
		if (textPart !== null) messages.unshift({ type: ev.type, time: ev.time ?? null, text: textPart });
	}
	return messages;
}

/** 注册 /plugins/session-tools/preview?id=<会话id>：返回该会话最近几条对话（只读）。 */
function registerPreviewRoute(ctx, webServer) {
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: PREVIEW_ROUTE_PATH,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const id = url.searchParams.get("id") ?? "";
			if (id === "") {
				sendJson(res, 400, { error: "missing-id", message: "缺少会话 id（?id=...）" });
				return;
			}
			try {
				const path = await findLogPath(id);
				if (path === null) {
					sendJson(res, 404, { error: "not-found", message: `找不到会话 ${id} 的日志文件。` });
					return;
				}
				const text = decodeZstdFrames(readFileSync(path));
				const messages = recentMessagesFromText(text, 20);
				sendJson(res, 200, {
					id,
					path: basename(dirname(path)), // 只回项目目录名，不回完整磁盘路径（隐私）
					count: messages.length,
					messages
				});
			} catch (error) {
				sendJson(res, 500, { error: "preview-failed", message: String(error?.message ?? error) });
			}
		}
	}), "session-tools: preview route");
}

/**
 * 孤儿清理的共享实现（/clean-orphans 与 /empty-trash 清空后都走这里）。
 * 返回人类可读的结果文本；不可用时 throw，由调用方决定降级。
 */
async function cleanOrphansInternal(ctx) {
	const sd = ctx.get("storageDomain");
	if (!sd) throw new Error("无法访问 storageDomain，清理中断。");
	const proj = sd.get("session_projcache");
	if (!proj || typeof proj.table !== "function") throw new Error("无法访问 session_projcache 域。");
	let sessions;
	try { sessions = proj.table("sessions"); } catch { throw new Error("无 sessions 表。"); }
	const ids = [];
	try { for (const [id] of sessions.entries()) ids.push(id); } catch { /* 表已关闭 */ }
	const orphans = [];
	const kept = [];
	for (const id of ids) {
		const exists = await hasSessionDirOnDisk(id).catch(() => true);
		(exists ? kept : orphans).push(id);
	}
	if (orphans.length === 0) {
		return `（孤儿检查：无孤儿，projcache 共 ${ids.length} 条会话仍有效。）`;
	}
	let removed = 0;
	for (const id of orphans) {
		try {
			const r = await stripStorageDomains(ctx, id);
			if (r.projRemoved || r.workspaceRemoved || r.archivedRemoved) removed++;
		} catch { /* 单条失败继续 */ }
	}
	// 方案 B：重建 registry 内存索引，清掉已删孤儿的撞车残留（免重启）。
	try { await rebuildRegistryIndex(ctx); } catch { /* 索引重建失败不阻塞清理（重启会兜底） */ }
	return `清理 ${removed} 条孤儿（projcache 有记录但目录已删）。\n清掉：${orphans.join("、")}\n保留 ${kept.length} 条有效会话。`;
}

function apply(ctx) {
	const register = (cmd) => ctx.effect(function* () {
		yield ctx.commands.register(cmd);
	}, `session-tools: ${cmd.name}`);
	register({
		name: "delete-session",
		description: "删除会话（移入回收站，可恢复）",
		handler: async (invocation) => {
			const arg = invocation.rawInput.trim();
			if (arg === "") return { kind: "error", text: "用法：/delete-session <会话id或标题>" };
			const titles = titlesFromProjcache();
			const ids = new Set((await ctx.get("sessionPersistence").list()).map((h) => String(h.id)));
			const resolved = resolveSessionId(arg, ids, titles);
			if (resolved === null) return { kind: "error", text: `没有匹配到会话 "${arg}"。可用 /trash 或让 agent 列出会话。` };
			if (Array.isArray(resolved)) return { kind: "error", text: `"${arg}" 匹配到多个会话，请指定 id：\n${candidateText(resolved, titles)}` };
			try {
				return await trashSession(ctx, invocation, resolved, titles);
			} catch (error) {
				return { kind: "error", text: `删除失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});
	register({
		name: "recycle-session",
		description: "删除会话（移入系统回收站，可在资源管理器恢复）",
		handler: async (invocation) => {
			const arg = invocation.rawInput.trim();
			if (arg === "") return { kind: "error", text: "用法：/recycle-session <会话id或标题>" };
			const titles = titlesFromProjcache();
			const ids = new Set((await ctx.get("sessionPersistence").list()).map((h) => String(h.id)));
			const resolved = resolveSessionId(arg, ids, titles);
			if (resolved === null) return { kind: "error", text: `没有匹配到会话 "${arg}"。` };
			if (Array.isArray(resolved)) return { kind: "error", text: `"${arg}" 匹配到多个会话，请指定 id：\n${candidateText(resolved, titles)}` };
			const live = refuseLive(ctx, invocation, resolved);
			if (live !== null) return { kind: "error", text: live };
			try {
				const located = await locateSession(ctx, resolved);
				if (located === null) return { kind: "error", text: `找不到会话 ${resolved}（可能已删除或不存在）。` };
				await sendToRecycleBin(located.sessionDir);
				// 二级删=进系统回收站，彻底清 projcache 行 + workspace 账目。
				try { await stripStorageDomains(ctx, resolved); } catch { /* 账目清理失败不阻塞删除 */ }
				// 方案 B：重建 registry 内存索引，清掉已删 id 的撞车残留（免重启）。
				try { await rebuildRegistryIndex(ctx); } catch { /* 索引重建失败不阻塞删除（重启会兜底） */ }
				return {
					kind: "success",
					text: `已把会话 ${resolved}（"${titles.get(resolved) ?? "无标题"}"）移入系统回收站。\n需要找回时在 Windows 回收站里还原即可（会回到原位置）。`
				};
			} catch (error) {
				return { kind: "error", text: `移入回收站失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});
	register({
		name: "restore-session",
		description: "从回收站恢复会话",
		handler: async (invocation) => {
			const arg = invocation.rawInput.trim();
			if (arg === "") return { kind: "error", text: "用法：/restore-session <会话id或标题>" };
			const titles = titlesFromProjcache();
			const projects = await readdir(trashRoot(), { withFileTypes: true }).catch(() => []);
			const trashIds = [];
			for (const project of projects) {
				if (!project.isDirectory()) continue;
				for (const entry of await readdir(join(trashRoot(), project.name), { withFileTypes: true }).catch(() => [])) {
					if (entry.isDirectory()) trashIds.push(entry.name);
				}
			}
			const resolved = resolveSessionId(arg, new Set(trashIds), titles);
			if (resolved === null) return { kind: "error", text: `回收站里没有匹配 "${arg}" 的会话。可用 /trash 查看。` };
			if (Array.isArray(resolved)) return { kind: "error", text: `"${arg}" 匹配到多个回收站会话，请指定 id：\n${candidateText(resolved, titles)}` };
			try {
				return await restoreSession(ctx, resolved, titles);
			} catch (error) {
				return { kind: "error", text: `恢复失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});
	register({
		name: "trash",
		description: "查看会话回收站",
		handler: () => listTrash(titlesFromProjcache())
	});
	register({
		name: "empty-trash",
		description: "清空会话回收站（物理删除，不可恢复）",
		handler: async (invocation) => {
			// 二次确认（借鉴 wsxwj123/dsh-session-manager 的 emptyTrash confirm:true 门槛）。
			const arg = invocation.rawInput.trim();
			if (arg !== "confirm") {
				return { kind: "error", text: "将物理删除回收站里所有会话，不可恢复。若确认，请输入：/empty-trash confirm" };
			}
			try {
				await rm(trashRoot(), { recursive: true, force: true });
				// 清空回收站后，projcache 里指向 .trash 的会话已成孤儿，顺手扫掉（用户已确认一键清）。
				let orphanNote = "";
				try {
					const result = await cleanOrphansInternal(ctx);
					orphanNote = `\n${result}`;
				} catch { /* 孤儿清扫失败不阻塞清空本身 */ }
				return { kind: "success", text: `回收站已清空。${orphanNote}` };
			} catch (error) {
				return { kind: "error", text: `清空失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});
	register({
		name: "clean-orphans",
		description: "清理残留孤儿：projcache 有记录但磁盘日志目录已不存在的会话",
		handler: async () => {
			try {
				const text = await cleanOrphansInternal(ctx);
				return { kind: "success", text };
			} catch (error) {
				return { kind: "error", text: String(error?.message ?? error) };
			}
		}
	});
	register({
		name: "archived",
		description: "列出归档会话（补官方缺失的归档查看入口）",
		handler: async () => {
			const archivedIds = readArchivedIds(ctx);
			if (archivedIds === void 0) {
				return { kind: "error", text: "无法访问 workspace registry，读不到归档集合。" };
			}
			if (archivedIds.length === 0) return { kind: "success", text: "没有归档的会话。" };
			const titles = titlesFromProjcache();
			const rows = buildArchivedRows(ctx, archivedIds, titles);
			return {
				kind: "success",
				text: `归档会话（${archivedIds.length} 个）：\n${formatArchivedRows(rows)}\n\n取消归档：/unarchive <id>`
			};
		}
	});
	register({
		name: "unarchive",
		description: "取消归档会话，回原工作区",
		handler: async (invocation) => {
			const arg = invocation.rawInput.trim();
			if (arg === "") return { kind: "error", text: "用法：/unarchive <会话id或标题>" };
			const archivedIds = readArchivedIds(ctx);
			if (archivedIds === void 0) return { kind: "error", text: "无法访问 workspace registry，读不到归档集合。" };
			const titles = titlesFromProjcache();
			const resolved = resolveSessionId(arg, new Set(archivedIds), titles);
			if (resolved === null) return { kind: "error", text: `归档集合里没有匹配 "${arg}" 的会话。可用 /archived 查看。` };
			if (Array.isArray(resolved)) return { kind: "error", text: `"${arg}" 匹配到多个归档会话，请指定 id：\n${candidateText(resolved, titles)}` };
			try {
				return await unarchiveSession(ctx, resolved);
			} catch (error) {
				return { kind: "error", text: `取消归档失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});
	register({
		name: "archive-session",
		description: "归档会话（从分组视图隐藏，日志与位置保留，可取消归档还原）",
		handler: async (invocation) => {
			const arg = invocation.rawInput.trim();
			if (arg === "") return { kind: "error", text: "用法：/archive-session <会话id或标题>" };
			const titles = titlesFromProjcache();
			const ids = new Set((await ctx.get("sessionPersistence").list()).map((h) => String(h.id)));
			const resolved = resolveSessionId(arg, ids, titles);
			if (resolved === null) return { kind: "error", text: `没有匹配到会话 "${arg}"。` };
			if (Array.isArray(resolved)) return { kind: "error", text: `"${arg}" 匹配到多个会话，请指定 id：\n${candidateText(resolved, titles)}` };
			try {
				return await archiveSessionById(ctx, resolved);
			} catch (error) {
				return { kind: "error", text: `归档失败：${error instanceof Error ? error.message : String(error)}` };
			}
		}
	});

	// 懒绑定 web 查询面：webServer 可能晚于本插件挂载（同 dsh-archived-chats）。
	let webRegistered = false;
	const registerWeb = () => {
		if (webRegistered) return;
		const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
		if (webServer === void 0) return;
		webRegistered = true;
		registerStateRoute(ctx, webServer);
		registerPreviewRoute(ctx, webServer);
	};
	registerWeb();
	ctx.on("internal/service", (serviceName) => {
		if (WEB_SERVER_KEYS.includes(serviceName)) registerWeb();
	});
}
//#endregion
export { apply, inject, name };
