/**
 * agent-tracker — 官方 AgentHandle 生命周期跟踪（dsh 0.1.1-rc.2）
 *
 * 背景：sessionQuery 的会话列表 = 磁盘扫描 ∪ 合并内存 live 会话。被"打开过"的会话
 * 删除后，其对象仍驻留内存 store（无官方删除 RPC），侧栏因此残留"未分组"幽灵行，
 * 直到进程重启。官方 `AgentHandle.dispose()`（`agents.create/resume` 的返回值）是
 * 公开的生命周期入口：cancel → drain → unregister → detach，会话随之离开 store。
 *
 * 本模块包装 agents.create/resume（保留原实现），把每个会话的 AgentHandle 登记下来，
 * 供删除流程"先安全停止、再删文件"，删除后 live store 即时清空，无需重启。
 * 语义与 dsh-chat-manager 的 installAgentHandleTracker 同构；官方未来落地
 * SessionPersistence.delete / session.delete RPC 后可整体替换。
 */

/**
 * 安装 tracker 并返回操作面。
 * @param agents - ctx.get("agents")（AgentRegistry）
 * @param sessions - ctx.get("sessions")（SessionStore，可选）
 * @returns 操作面；agents 不满足包装条件（老版本）时返回 null，调用方回退旧语义。
 */
export function createAgentTracker(agents, sessions) {
	if (!agents || typeof agents.create !== "function" || typeof agents.resume !== "function") {
		return null;
	}
	const handles = new Map();
	const deleting = new Set();
	const originals = {
		create: agents.create,
		resume: agents.resume,
		enter: typeof agents.enter === "function" ? agents.enter : null,
	};

	const track = (handle) => {
		if (handle && handle.agent && typeof handle.agent.id === "string" && typeof handle.dispose === "function") {
			handles.set(handle.agent.id, handle);
		}
		return handle;
	};
	const assertAvailable = (sessionId) => {
		if (typeof sessionId === "string" && deleting.has(sessionId)) {
			throw new Error(`session "${sessionId}" is being permanently deleted`);
		}
	};

	agents.create = async function (...args) {
		assertAvailable(args[0]?.sessionId);
		return track(await Reflect.apply(originals.create, this, args));
	};
	agents.resume = async function (...args) {
		assertAvailable(args[0]?.resumeSessionId);
		return track(await Reflect.apply(originals.resume, this, args));
	};
	if (originals.enter) {
		agents.enter = function (...args) {
			assertAvailable(args[0]?.id);
			return Reflect.apply(originals.enter, this, args);
		};
	}

	/** 删除期间占位：阻止该会话被重新打开/创建（被包装的入口会抛错）。 */
	function reserve(id) {
		deleting.add(id);
		return () => { deleting.delete(id); };
	}

	/**
	 * 安全停止一个已加载会话：调 AgentHandle.dispose()，随后校验已离开 agents/sessions store。
	 * @returns { ok: true } | { ok: false, text }
	 */
	async function stopSession(id) {
		const agent = agents.get ? agents.get(id) : undefined;
		if (agent === void 0) return { ok: true }; // 未加载：无需停止
		const handle = handles.get(id);
		if (handle === void 0 || typeof handle.dispose !== "function") {
			return { ok: false, text: `会话 ${id} 已加载但拿不到 AgentHandle，无法安全停止，未删除。` };
		}
		try {
			await handle.dispose();
		} catch (error) {
			return { ok: false, text: `停止会话 ${id} 失败：${error instanceof Error ? error.message : String(error)}` };
		}
		const stillAgent = agents.get ? agents.get(id) !== void 0 : false;
		const stillSession = !!(sessions && sessions.get && sessions.get(id) !== void 0);
		if (stillAgent || stillSession) {
			return { ok: false, text: `会话 ${id} 未能完整卸载（仍驻留内存），未删除。` };
		}
		handles.delete(id);
		return { ok: true };
	}

	/** 还原被包装的方法（插件卸载时调用）。 */
	function release() {
		if (agents.create !== originals.create) agents.create = originals.create;
		if (agents.resume !== originals.resume) agents.resume = originals.resume;
		if (originals.enter && agents.enter !== originals.enter) agents.enter = originals.enter;
		handles.clear();
		deleting.clear();
	}

	return { reserve, stopSession, release };
}