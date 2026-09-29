/**
 * 扩展入口 + iframe 桥。UI 在 iframe/chat.html；写画布/写库/导出必须走确认卡令牌。
 */
import type { AgentEvent, CatalogStatsView, ChatTurnResult, PlaceCbbItem } from './agent/loop';
import type { ClientEnv } from './env';
import type { JevSettings, LlmSettings, PlacementSettings } from './settings';
import * as extensionConfig from '../extension.json';
import { abortSession } from './agent/http';
import { testJevConnection } from './agent/jev';
import { cancelCard, chatTurn, confirmEdit, confirmExport, confirmPlace, resetChatSession, testLlmConnection } from './agent/loop';
import { detectClientEnv, runSelfCheck } from './env';
import { edaGlobal } from './host';
import { getDefaultStylePrompt, getJevSettings, getLibraryScope, getLlmSettings, getLocalLibraryPath, getPlacementSettings, getStylePresets, getStylePrompt, saveJevSettings, saveLibraryScope, saveLlmSettings, saveLocalLibraryPath, savePlacementSettings, saveStylePrompt } from './settings';

export const VERSION = extensionConfig.version;

export interface CbbCopilotBridge {
	version: string;
	getLlmSettings: () => LlmSettings;
	saveLlmSettings: (s: LlmSettings) => void;
	/** Jev 语义推荐设置（独立 Key 与开关；与主 LLM 相互独立）。 */
	getJevSettings: () => JevSettings;
	saveJevSettings: (s: JevSettings) => void;
	getLibraryScope: () => Record<string, boolean>;
	saveLibraryScope: (scope: Record<string, boolean>) => void;
	getLocalLibraryPath: () => string;
	saveLocalLibraryPath: (path: string) => void;
	getPlacementSettings: () => PlacementSettings;
	savePlacementSettings: (s: PlacementSettings) => void;
	/** 用户自定义的风格与限制（附在固定工作流程之后）。 */
	getStylePrompt: () => string;
	getDefaultStylePrompt: () => string;
	getStylePresets: () => { rigorous: string; relaxed: string };
	saveStylePrompt: (text: string) => void;
	/** 注册 Agent 事件监听（每次 chatTurn 实时推送 reasoning/text delta、工具状态、卡片）。重复注册覆盖旧监听。 */
	onAgentEvent: (sessionId: string, handler: (ev: AgentEvent) => void) => void;
	/** 中止进行中的 chatTurn（按钮置为停止时的调用）。返回是否有进行中的轮次被中止。 */
	abortChatTurn: (sessionId: string) => boolean;
	chatTurn: (sessionId: string, userText: string) => Promise<ChatTurnResult>;
	confirmPlace: (sessionId: string, token: string, items: Array<PlaceCbbItem>, grid?: { dx: number; dy: number }) => Promise<{ results: Array<{ cbbUuid: string; name: string; ok: boolean; error?: string; pageName?: string; fallbackFromSymbol?: boolean }> }>;
	confirmEdit: (sessionId: string, token: string, editable: { name: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
	confirmExport: (sessionId: string, token: string, uuids: Array<string>) => Promise<{ ok: boolean; stats?: CatalogStatsView; fileName?: string; error?: string }>;
	cancelCard: (sessionId: string, token: string) => void;
	resetChatSession: (sessionId: string) => void;
	selfCheck: () => Promise<string>;
	testConnection: () => Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }>;
	/** Jev 链路连通性测试（最小 noul 评估）：校验 Jev baseUrl / Key / model。 */
	testJevConnection: () => Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }>;
	getClientEnv: () => Promise<ClientEnv>;
}

/** 会话 → 事件监听（UI 注册；同一会话只保留最新监听，UI 重载后自动覆盖旧引用）。 */
const agentEventListeners = new Map<string, (ev: AgentEvent) => void>();

function installBridge(): void {
	const edaRef = edaGlobal();
	if (!edaRef)
		return;
	const bridge: CbbCopilotBridge = {
		version: VERSION,
		getLlmSettings,
		saveLlmSettings,
		getJevSettings,
		saveJevSettings,
		getLibraryScope,
		saveLibraryScope,
		getLocalLibraryPath,
		saveLocalLibraryPath,
		getPlacementSettings,
		savePlacementSettings,
		getStylePrompt,
		getDefaultStylePrompt,
		getStylePresets,
		saveStylePrompt,
		onAgentEvent: (sessionId, handler) => {
			if (typeof handler === 'function')
				agentEventListeners.set(sessionId, handler);
			else
				agentEventListeners.delete(sessionId);
		},
		abortChatTurn: sessionId => abortSession(sessionId),
		chatTurn: (sessionId, userText) => chatTurn(sessionId, userText, VERSION, {
			onEvent: (ev) => {
				// 监听器异常与 UI 生命周期解耦：回调抛错只记日志，不中断 agent 循环。
				try {
					agentEventListeners.get(sessionId)?.(ev);
				}
				catch (e) {
					console.warn('[cbb-copilot] onAgentEvent handler error:', e);
				}
			},
		}),
		confirmPlace,
		confirmEdit,
		confirmExport,
		cancelCard,
		resetChatSession: (sessionId) => {
			agentEventListeners.delete(sessionId);
			resetChatSession(sessionId);
		},
		selfCheck: () => runSelfCheck(VERSION),
		testConnection: () => testLlmConnection(),
		testJevConnection: () => testJevConnection(getJevSettings()),
		getClientEnv: () => detectClientEnv(),
	};
	edaRef.ai_reuse_block_placement = bridge;
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	console.warn(`ai-reuse-block-placement v${VERSION} activated`);
	installBridge();
}

export function deactivate(): void {
	console.warn('AI Reuse Block Placement deactivated');
}

export async function openCopilot(): Promise<void> {
	installBridge();
	if (typeof eda !== 'undefined' && eda.sys_IFrame) {
		let title = 'AI Reuse Block Placement';
		try {
			const lang = await eda.sys_I18n?.getCurrentLanguage?.();
			if (lang && String(lang).toLowerCase().startsWith('zh')) {
				title = '复用模块智能助手';
			}
		}
		catch { /* 回退英文标题 */ }
		const success = await eda.sys_IFrame.openIFrame(
			'/iframe/chat.html',
			440,
			720,
			'ai-reuse-block-placement',
			{ title, maximizeButton: true, minimizeButton: true },
		);
		if (!success) {
			console.error('Failed to open AI Reuse Block Placement panel');
		}
	}
}

if (typeof window !== 'undefined' && typeof eda !== 'undefined') {
	activate();
}
