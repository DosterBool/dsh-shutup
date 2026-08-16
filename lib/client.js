/**
 * ============================================================================
 * dsh-shutup 浏览器半侧（browser half）—— 打断提示（Tell DeepSeek）
 * ============================================================================
 *
 * 【功能】
 *   模型思考/输出时按下快捷键（默认 Ctrl+Shift+Q）：
 *     - 弹出输入框，未输入时不暂停（空确认/取消 = 直接关闭，零干扰）
 *     - 开始输入即暂停当前生成（session.cancel()，与界面停止按钮同款 RPC，
 *       已生成的截断内容与待处理队列保留不丢弃）
 *     - 输入纠偏文字 → 二次确认 → steer 中止运行中的回合并注入为新一步
 *       （自动加前缀「[打断提示/纠偏]：」；steer 自带打断，无需单独 cancel）
 *     - 输入过又取消 / 删空后确认 → 发送「[继续]」指令，模型继续原来的思考
 *   其他时间（模型未运行）快捷键自动禁用——用户可以直接在输入框正常输入。
 *   IME 兼容：输入法组合期（isComposing/keyCode 229）的按键全部交给输入法，
 *   回车确认候选词不会误触发发送；快捷键用 e.code 物理键匹配，CapsLock 不影响。
 *
 * 【配置】
 *   快捷键在 设置 → 通用 → 打断提示 (Shutup) 里录制修改（按下即捕获，
 *   存 localStorage 'dsh-shutup-config'），默认 Ctrl+Shift+Q
 *   （避开空格键——Shift+空格=中文输入法全半角切换会被 IME 层拦截）。
 *
 * 【实现要点】
 *   - 挂在 conversation.composer.dock（会话作用域槽位）：拿到
 *     ConversationSnapshot.running 与 sessionId，无需自己维护会话状态
 *   - 全局 keydown 用捕获阶段监听，确保抢在页面其他处理之前
 *   - sessions 客户端服务：binding(sessionId).session → SessionFace
 *   - 弹窗 createPortal 到 document.body，全屏遮罩浮在 UI 之上
 * ============================================================================
 */
window.__ModuleLoader__.load({
	// 插件唯一 ID，必须与 package.json 里声明的一致
	id: 'dsh-shutup',

	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		try { console.log('[dsh-shutup] client bundle loaded (demo: A+B 思考链回填版)'); } catch (e) {}

		const { jsx: h } = require('react/jsx-runtime');
		const { useState, useEffect, useRef } = require('react');
		const { createPortal } = require('react-dom');

		// ---- 快捷键配置（localStorage 持久化） ----
		const CFG_KEY = 'dsh-shutup-config';
		// 默认 Ctrl+Shift+Q：避开空格键（Shift+空格=中文输入法全半角切换会被 IME 层拦截），
		// 且用 e.code 匹配物理键，CapsLock/大小写状态不影响触发
		const CFG_DEFAULTS = { code: 'KeyQ', ctrl: true, shift: true, alt: false, meta: false };
		function loadCfg() {
			let merged = null;
			try {
				const raw = JSON.parse(localStorage.getItem(CFG_KEY));
				if (raw && typeof raw === 'object') {
					// 旧版双快捷键配置 → 取其中的「打断」快捷键
					if (raw.interrupt && typeof raw.interrupt === 'object') merged = { ...CFG_DEFAULTS, ...raw.interrupt };
					else if (typeof raw.code === 'string') merged = { ...CFG_DEFAULTS, ...raw };
				}
			} catch (e) { /* 损坏则用默认 */ }
			if (merged === null) return { ...CFG_DEFAULTS };
			// 旧默认是 Ctrl+Shift+空格：含空格的组合会被中文输入法（Shift+空格=全半角切换）
			// 在 IME 层拦截，自动迁移到新默认 Ctrl+Shift+Q（用户自行录制的其他键不受影响）
			if (merged.code === 'Space') return { ...CFG_DEFAULTS };
			return merged;
		}
		function saveCfg(c) {
			try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) { /* noop */ }
		}
		const CODE_LABELS = {
			Space: '空格', Escape: 'Esc', Enter: '回车', Tab: 'Tab', Backspace: '退格',
			ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
			Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
			BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=',
			Backslash: '\\',
		};
		function codeLabel(code) {
			if (!code) return '?';
			if (CODE_LABELS[code]) return CODE_LABELS[code];
			if (code.indexOf('Key') === 0) return code.slice(3);
			if (code.indexOf('Digit') === 0) return code.slice(5);
			if (code.indexOf('F') === 0 && code.length <= 3) return code;
			return code;
		}
		function comboLabel(c) {
			if (!c || typeof c !== 'object' || typeof c.code !== 'string') return '未设置';
			return (c.ctrl ? 'Ctrl+' : '') + (c.shift ? 'Shift+' : '') + (c.alt ? 'Alt+' : '') + (c.meta ? 'Meta+' : '') + codeLabel(c.code);
		}
		function matchCombo(e, c) {
			return e.code === c.code &&
				!!e.ctrlKey === !!c.ctrl && !!e.shiftKey === !!c.shift &&
				!!e.altKey === !!c.alt && !!e.metaKey === !!c.meta;
		}

		// ---- 内联 CSS ----
		const css = [
			// dock 里的快捷键小提示（仅模型运行中显示，点击同样可打断）
			'.dsup-hint{font-size:11px;line-height:1.4;color:var(--color-fg-muted,#8b8e98);cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.dsup-hint:hover{color:var(--color-fg,#333)}',
			// 打断输入弹窗：全屏遮罩浮在 UI 之上
			'.dsup-mask{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}',
			'.dsup-box{width:440px;max-width:calc(100vw - 40px);background:var(--color-bg-panel,#fff);color:var(--color-fg,#333);border:1px solid var(--color-border,#d7d9e0);border-radius:12px;padding:16px;box-shadow:0 16px 50px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:10px;font-size:12px;text-align:left}',
			'.dsup-title{font-size:13px;font-weight:600}',
			'.dsup-ta{width:100%;box-sizing:border-box;resize:vertical;min-height:80px;padding:8px 10px;border-radius:8px;border:1px solid var(--color-border,#d7d9e0);background:var(--color-bg-input,#fff);color:inherit;font-size:12px;line-height:1.6;font-family:inherit}',
			'.dsup-ta:focus{outline:none;border-color:#46a758}',
			'.dsup-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}',
			'.dsup-note{color:var(--color-fg-muted,#888);flex:1;text-align:left}',
			'.dsup-err{color:#e5484d;font-size:11px;line-height:1.5;text-align:left}',
			'.dsup-btn{margin:0;padding:3px 12px;font-size:12px;line-height:18px;border-radius:8px;border:1px solid var(--color-border,#d7d9e0);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
			'.dsup-btn:hover{background:var(--color-bg-hover,rgba(128,128,128,.08))}',
			'.dsup-btn:disabled{opacity:.5;cursor:default}',
			'.dsup-btn.dsup-primary{background:#46a758;border-color:#46a758;color:#fff}',
			'.dsup-btn.dsup-primary:hover{background:#3d9150}',
			// 纠偏二级确认的红色确认态
			'.dsup-btn.dsup-danger{background:#e5484d;border-color:#e5484d;color:#fff;font-weight:600}',
			'.dsup-btn.dsup-danger:hover{background:#c93d42}',
			// 通用设置页区块
			'.dsup-gen{display:flex;flex-direction:column;gap:8px;width:100%;padding:2px 0;color:var(--color-fg,#333);font-size:12px;text-align:left}',
			'.dsup-gen .dsup-title{font-size:13px;font-weight:600}',
			'.dsup-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
		].join('\n');
		const cssTag = 'dsh-shutup/style.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-shutup';
			tag.dataset.pluginCss = cssTag;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ---- 由 apply 注入的客户端服务 ----
		let sessionsSvc = null;
		let rootCtx = null;   // apply 时暂存的 ctx，用于每次调用时懒解析 sessions（防装配时序脆弱）
		// 最近一次在可编辑区域敲入可见字符的时间戳：防误触只在"正在连续打字"时生效，
		// 焦点停留在输入框但没在打字（最常见状态）时不拦截快捷键
		let lastTypingAt = 0;

		// ---- 主条目：快捷键监听 + 打断弹窗 ----
		function ShutupEntry({ session }) {
			const [cfg, setCfg] = useState(loadCfg);
			const [open, setOpen] = useState(false);
			const [text, setText] = useState('');
			const [sending, setSending] = useState(false);
			const [errMsg, setErrMsg] = useState('');
			const [confirmArmed, setConfirmArmed] = useState(false);   // 纠偏二级确认：第一次点击变红确认态
			const taRef = useRef(null);
			const armTimerRef = useRef(null);   // 二级确认 4s 自动还原定时器
			const pausedRef = useRef(false);    // 本次弹窗是否已暂停当前生成（输入才暂停）
			const sessionId = session && session.sessionId ? String(session.sessionId) : '';
			const running = !!(session && session.running);

			const sessionFace = () => {
				try {
					// 每次调用时懒解析：apply 时机若拿不到 sessions 服务，后续调用仍可兜底重取
					const svc = (rootCtx !== null && typeof rootCtx.get === 'function' ? rootCtx.get('sessions') : null) || sessionsSvc;
					const b = svc && sessionId ? svc.binding(sessionId) : undefined;
					return b && b.session ? b.session : null;
				} catch (e) {
					return null;
				}
			};

			// ---- 动作集（简化语义：输入才暂停 / 空确认·取消 = 继续 / 有内容 = 二级确认后载入纠偏） ----
			// 输入才暂停：cancel 与界面停止按钮同款 RPC，截断内容与待处理队列保留
			const pauseNow = () => {
				const face = sessionFace();
				if (face && typeof face.cancel === 'function') face.cancel().catch(() => {});
			};
			const disarm = () => {
				setConfirmArmed(false);
				if (armTimerRef.current !== null) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
			};
			// ---- 思考链回填（方案 A）：优先摘"被打断回合"（interrupted 标记）的思考/输出末尾 ----
			// 官方类型：AssistantMessageNode { kind:'assistant', blocks: AssistantBlock[], interrupted?: true }
			// AssistantBlock = { kind:'reasoning', text } | { kind:'text', text } | …
			// 打断后回合以 interrupted:true 落进 legacy.nodes；竞态下节点未落定时，
			// 兜底读取 snapshot.partial.blocks（刚截断的累积块，形状相同）。
			// 两个来源都摘不到才返回 null——绝不拿上一个回合的内容充数。
			const pickTailBlocks = (blocks) => {
				if (!Array.isArray(blocks)) return null;
				let reasoning = '';
				let output = '';
				for (const b of blocks) {
					if (!b || typeof b.text !== 'string') continue;
					if (b.kind === 'reasoning' && reasoning.length === 0) reasoning = b.text;
					if (b.kind === 'text' && output.length === 0) output = b.text;
				}
				if (reasoning.length === 0 && output.length === 0) return null;
				const clip = (s, n) => s.length > n ? '（前文省略）…' + s.slice(-n) : s;
				return {
					reasoning: reasoning.length > 0 ? clip(reasoning, 1500) : '',
					output: output.length > 0 ? clip(output, 500) : '',
				};
			};
			const extractChainTail = (snap) => {
				try {
					// 1) 被打断回合的 legacy 节点（turn/end 已落定）
					const nodes = snap && snap.chat && snap.chat.legacy && snap.chat.legacy.nodes;
					if (Array.isArray(nodes)) {
						for (let i = nodes.length - 1; i >= 0; i--) {
							const node = nodes[i];
							if (!node || node.kind !== 'assistant' || node.interrupted !== true) continue;
							const tail = pickTailBlocks(node.blocks);
							if (tail !== null) return tail;
						}
					}
					// 2) 兜底：partial（回合还没完全收敛时，截断内容仍在 partial.blocks 里）
					if (snap && snap.partial && Array.isArray(snap.partial.blocks)) {
						const tail = pickTailBlocks(snap.partial.blocks);
						if (tail !== null) return tail;
					}
					return null;
				} catch (e) {
					return null;   // 摘取失败退化为裸 [继续] 指令
				}
			};

			// 发送「继续」：失败时重新打开弹窗并显示错误（不再静默失败）
			const sendContinue = async (msg) => {
				const face = sessionFace();
				if (!face || typeof face.prompt !== 'function') {
					setErrMsg('未取到会话接口，「继续」发送失败（弹窗保留，可重试）');
					setOpen(true);
					return;
				}
				try {
					await face.prompt([{ type: 'text', text: msg }], 'steer');
				} catch (e) {
					setErrMsg('「继续」发送失败：' + String(e && e.message ? e.message : e) + '（弹窗保留，可重试）');
					setOpen(true);
				}
			};

			// 回填文本走宿主一次性上下文注入（systemPrompt.context）：会话里呈现为
			// 可折叠/可展开的上下文行（折叠=一行摘要，展开=全文），模型照常拿到完整内容；
			// 可见消息只发一句话。POST 失败时退化为全文直发（内容优先）。
			const postBackfill = async (text) => {
				try {
					const r = await fetch('/shutup/backfill', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId, text }),
					});
					if (!r.ok) return false;
					const j = await r.json().catch(() => null);
					return !!(j && j.ok === true);
				} catch (e) {
					return false;
				}
			};

			// 继续原来的思考（方案 A）：从 SessionFace.getSnapshot() 读最新快照（避开渲染闭包的
			// 陈旧 session）。摘取顺序：interrupted 节点 → partial.blocks 兜底；工具调用等
			// 慢收敛场景下 turn/end 可能数秒才落定，重试 6 次×500ms（最长 2.5s）。
			// 仍摘不到才退化为裸 [继续] 指令。回填上下文投递到宿主（先于会话组装），
			// 可见消息只发一句话。
			const continueThinking = async () => {
				const face = sessionFace();
				let tail = null;
				if (face && typeof face.getSnapshot === 'function') {
					for (let i = 0; i < 6 && tail === null; i++) {
						if (i > 0) await new Promise((resolve) => setTimeout(resolve, 500));
						tail = extractChainTail(face.getSnapshot());
					}
				} else {
					tail = extractChainTail(session);
				}
				try { console.log('[dsh-shutup] backfill tail:', tail === null ? 'null（退化为裸 [继续]）' : ('命中（reasoning ' + tail.reasoning.length + ' 字 / output ' + tail.output.length + ' 字）')); } catch (e) {}
				const shortMsg = '[继续] 继续你刚才的思考与工作。';
				if (tail === null) {
					await sendContinue(shortMsg);
					return;
				}
				const parts = [];
				if (tail.reasoning.length > 0) parts.push('--- 思考过程末尾 ---\n' + tail.reasoning);
				if (tail.output.length > 0) parts.push('--- 输出末尾 ---\n' + tail.output);
				const backfill = '[继续] 你刚才的思考与输出被暂停（内容可能截断）。暂停时的上下文如下：\n\n' +
					parts.join('\n\n') + '\n\n请接着完成未完成的部分。';
				// 先投递回填（保证先于该会话的提示词组装），成功则可见消息只发一句话
				const posted = await postBackfill(backfill);
				try { console.log('[dsh-shutup] backfill POST:', posted ? 'ok（走折叠上下文行）' : '失败（退化为全文直发）'); } catch (e) {}
				if (posted) {
					await sendContinue(shortMsg);
					return;
				}
				// 宿主回填不可用：退化为全文直发（内容优先，UI 占用变大但模型不丢上下文）
				await sendContinue(backfill);
			};
			const closeAndContinue = () => {
				disarm();
				setOpen(false);
				// 只有真的暂停过（输入过内容）才需要发「[继续]」恢复；从未输入 = 模型本来就没停
				if (pausedRef.current) void continueThinking();
			};
			const openBox = () => {
				disarm();
				pausedRef.current = false;
				setErrMsg('');
				setText('');
				setOpen(true);   // 打开不暂停：未输入不打断
			};
			// 载入纠偏（steer 官方语义自带中止并注入）；失败提示保留弹窗
			const sendCorrection = async () => {
				const hint = text.trim();
				if (!hint) return;
				setSending(true);
				setErrMsg('');
				const face = sessionFace();
				if (face && typeof face.prompt === 'function') {
					try {
						await face.prompt([{ type: 'text', text: '[打断提示/纠偏]：' + hint }], 'steer');
					} catch (e) {
						setSending(false);
						setErrMsg('载入失败：' + String(e && e.message ? e.message : e) + '（弹窗保留，可重试）');
						return;
					}
				} else {
					setSending(false);
					setErrMsg('未取到会话接口，载入失败（弹窗保留，可重试）');
					return;
				}
				setSending(false);
				setText('');
				setErrMsg('');
				disarm();
				setOpen(false);
			};
			// 主按钮：空 → 继续；有内容 → 二级确认后载入纠偏
			const primaryAction = () => {
				if (text.trim().length === 0) { closeAndContinue(); return; }
				if (!confirmArmed) {
					setConfirmArmed(true);
					if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
					armTimerRef.current = setTimeout(() => setConfirmArmed(false), 4000);
					return;
				}
				disarm();
				void sendCorrection();
			};
			// 开始输入才暂停当前生成（首个非空字符触发一次）：按快捷键且未输入时不暂停
			const onChangeTa = (e) => {
				const v = e.target.value;
				setText(v);
				if (v.trim().length > 0 && !pausedRef.current) {
					pausedRef.current = true;
					pauseNow();
				}
			};

			// 弹窗打开时聚焦输入框
			useEffect(() => {
				if (open && taRef.current) taRef.current.focus();
			}, [open]);
			// 卸载时清理二级确认定时器
			useEffect(() => () => { if (armTimerRef.current !== null) clearTimeout(armTimerRef.current); }, []);

			// 文本编辑元素守卫：焦点在 INPUT/TEXTAREA/contenteditable 时忽略快捷键，避免日常打字误触
			const isEditableTarget = (t) => {
				if (!t || typeof t !== 'object') return false;
				const tag = (t.tagName || '').toLowerCase();
				if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
				if (t.isContentEditable === true) return true;
				return false;
			};

			// 快捷键状态机防护：
			// 1) 严格作用域绑定——仅在模型运行（generating/thinking）且弹窗关闭时才挂载全局监听，
			//    其余时间彻底解绑（cleanup 里 removeEventListener），不做惰性忽略；
			// 2) 防冲突——焦点处于普通文本编辑状态（输入框/文本域/可编辑区）时直接忽略，
			//    日常敲键盘不会误触；此时可用状态条上的 ⌨ 提示点击打断。
			useEffect(() => {
				if (open || !running) return;   // 非运行期 / 弹窗打开期：彻底解绑
				const onKey = (e) => {
					// 注意：这里绝不能过滤 keyCode 229 / isComposing——中文输入法激活时，
					// 按键的 keydown 会以 key='Process'/keyCode 229 送达，但 e.code 与
					// 修饰键仍然正确；匹配只用 e.code + 修饰键，中文输入法下照样能触发。
					const editable = isEditableTarget(e.target);
					if (matchCombo(e, cfg)) {
						// 防误触只在"正在连续打字"时生效：1.5s 内刚在输入框敲过字 → 当作普通输入；
						// 焦点在输入框但没在打字 → 正常触发（解决发送后焦点滞留输入框导致的"时不时失效"）
						if (editable && Date.now() - lastTypingAt < 1500) {
							lastTypingAt = Date.now();
							return;
						}
						// 触发前先把焦点从输入元素移走：中文输入法（IME）下 preventDefault 挡不住
						// 字符上屏，不移走会在输入框里多敲出一个 z
						if (editable) {
							try {
								const ae = document.activeElement;
								if (ae && typeof ae.blur === 'function') ae.blur();
							} catch (err) { /* noop */ }
						}
						// 打断 + 纠偏：打开弹窗（未输入不暂停）；输入才暂停；空确认/取消 = 继续；有内容 = 二级确认后载入纠偏
						e.preventDefault();
						e.stopPropagation();
						openBox();
						return;
					}
					// 非快捷键按键：在可编辑区域敲入可见字符 → 记录"最近在打字"时间戳
					if (editable && !e.ctrlKey && !e.altKey && !e.metaKey &&
						typeof e.key === 'string' && e.key.length === 1) {
						lastTypingAt = Date.now();
					}
				};
				window.addEventListener('keydown', onKey, true);
				return () => window.removeEventListener('keydown', onKey, true);
			}, [cfg, open, running, sessionId]);

			const onTaKey = (e) => {
				// 输入法组合中：Enter/Esc 属于输入法（确认/取消候选），绝不能当作发送/关闭
				if (e.isComposing || e.keyCode === 229) return;
				if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); primaryAction(); }
				else if (e.key === 'Escape') { e.preventDefault(); closeAndContinue(); }
			};

			// 运行中显示快捷键小提示（点击同样可打断；不运行时渲染空）
			const hintEl = running
				? h('span', {
					className: 'dsup-hint',
					title: '打断当前思考并载入修正提示（快捷键可在 设置 → 通用 修改）',
					onClick: openBox,
					children: '⌨ 打断 ' + comboLabel(cfg),
				})
				: null;

			const modal = open
				? createPortal(h('div', { className: 'dsup-mask', onClick: closeAndContinue, children: [
					h('div', { className: 'dsup-box', onClick: (e) => e.stopPropagation(), children: [
						h('div', { className: 'dsup-title', children: '打断提示 · 告诉 DeepSeek 怎么改' }),
						h('textarea', {
							ref: taRef,
							className: 'dsup-ta',
							rows: 4,
							placeholder: '例如：\n· 别用循环，直接手写\n· 先给结论再解释\n· 这个函数改成异步的\n· 用中文回复',
							value: text,
							onChange: onChangeTa,
							onKeyDown: onTaKey,
						}),
						errMsg ? h('div', { className: 'dsup-err', children: errMsg }) : null,
						h('div', { className: 'dsup-actions', children: [
							h('span', { className: 'dsup-note', children: '打开不暂停；开始输入才暂停；空输入确认或取消 = 继续原来的思考（思考链以折叠上下文行回填，展开可见全文）；输入后需二次确认载入纠偏（自动加前缀「[打断提示/纠偏]：」）' }),
							h('button', { className: 'dsup-btn', type: 'button', onClick: closeAndContinue, children: '取消' }),
							h('button', {
								className: 'dsup-btn dsup-primary' + (confirmArmed ? ' dsup-danger' : ''),
								type: 'button',
								disabled: sending,
								onClick: primaryAction,
								children: sending
									? '载入中…'
									: (text.trim().length === 0
										? '继续'
										: (confirmArmed ? '确认载入纠偏？' : '载入纠偏')),
							}),
						] }),
					] }),
				] }), document.body)
				: null;

			return h('div', { className: 'dsup-cell', children: [hintEl, modal] });
		}

		// ---- 通用设置页条目：快捷键录制修改 ----
		function SettingsSection() {
			const [cfg, setCfg] = useState(loadCfg);
			const [recording, setRecording] = useState(false);

			useEffect(() => {
				if (!recording) return;
				const onKey = (e) => {
					// 只按修饰键不算，等完整组合（录制 e.code 物理键，输入法/大小写无关）
					if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
					e.preventDefault();
					e.stopPropagation();
					const next = { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
					saveCfg(next);
					setCfg(next);
					setRecording(false);
				};
				window.addEventListener('keydown', onKey, true);
				return () => window.removeEventListener('keydown', onKey, true);
			}, [recording]);

			return h('div', { className: 'dsup-gen', children: [
				h('div', { className: 'dsup-title', children: '打断提示（Shutup）' }),
				h('div', { className: 'dsup-note', children: '模型思考/输出时按下快捷键：弹出弹窗（未输入不暂停）；开始输入才暂停当前生成；输入内容需二次确认后载入纠偏；空输入确认或取消 = 继续原来的思考。其他时间快捷键自动禁用。中文输入法激活时也能正常触发（按物理键匹配）；仅当 1.5s 内刚在输入框敲过字时才当作普通输入，其余情况一律触发。' }),
				h('div', { className: 'dsup-row', children: [
					h('span', { className: 'dsup-note', children: '当前快捷键：' + comboLabel(cfg) }),
					recording
						? h('button', { className: 'dsup-btn dsup-primary', type: 'button', children: '请按下新的组合键…' })
						: h('button', { className: 'dsup-btn', type: 'button', onClick: () => setRecording(true), children: '修改快捷键' }),
					h('button', {
						className: 'dsup-btn',
						type: 'button',
						onClick: () => { const next = { ...CFG_DEFAULTS }; saveCfg(next); setCfg(next); setRecording(false); },
						children: '恢复默认',
					}),
				] }),
			] });
		}

		// ============================================================================
		// 插件主体（Cordis 插件三件套：name / inject / apply）
		// ============================================================================
		const name = 'shutup';      // 插件行 id（与 cordis.patch.yml 一致）
		const inject = ['slots'];   // 槽位注册表

		function apply(ctx, config) {
			rootCtx = ctx;
			const sessions = ctx.get('sessions');
			if (sessions !== undefined) sessionsSvc = sessions;

			// dock 槽位：拿到当前会话的运行状态 + sessionId
			ctx.slots.inject('conversation.composer.dock', function* () {
				yield ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'shutup',
					order: 600,
				}, (ownerProps) => h(ShutupEntry, { session: ownerProps && ownerProps.session }));
			});

			// 通用设置页（设置 → 通用 → 打断提示）：快捷键录制
			ctx.slots.inject('settings.general.item', () => ctx.slots.register({
				name: 'settings.general.item',
				id: 'shutup',
				order: 600,
				label: '打断提示 (Shutup)',
			}, () => h(SettingsSection, {})));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
