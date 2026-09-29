/**
 * 设置持久化：localStorage 优先、sys_Storage 兜底（双写）。
 * localStorage 在 EDA 主进程不可用（iframe 内才有），读写都 try/catch 双通道。
 */
import { DEFAULT_STYLE_PROMPT, STYLE_PRESET_RELAXED, STYLE_PRESET_RIGOROUS } from './agent/tools';
import { edaGlobal } from './host';

export type LlmProvider = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface LlmSettings {
	provider: LlmProvider;
	baseUrl: string;
	apiKey: string;
	model: string;
}

function parseProvider(raw: string): LlmProvider {
	if (raw === 'anthropic')
		return 'anthropic';
	if (raw === 'openai-responses')
		return 'openai-responses';
	return 'openai-chat';
}

const LS_PREFIX = 'jlc_cbb_copilot_';

const K_PROVIDER = 'llm_provider';
const K_BASE = 'llm_base_url';
const K_KEY = 'llm_api_key';
const K_MODEL = 'llm_model';
const K_SCOPE = 'library_scope';
const K_LOCAL_PATH = 'local_library_path';
const K_PLACE = 'placement_settings';
const K_STYLE = 'style_prompt';

/** 半离线模式下路径发现 API 全部失效时的本地库兜底路径。 */
export const DEFAULT_LOCAL_LIBRARY_PATH = 'C:\\Users\\JLC\\Documents\\LCEDA-Pro\\libraries';

/** 放置排布设置：模块间距与标注框样式（确认卡不再逐次调整，全局生效）。 */
export interface PlacementSettings {
	/** 模块占用框水平空隙（0.01 英寸），默认 80。 */
	gapX: number;
	/** 模块占用框垂直空隙（0.01 英寸），默认 80。 */
	gapY: number;
	/** 标注框颜色 #RRGGBB；空串 = 宿主默认。 */
	borderColor: string;
	/** 标注框线宽；空 = 宿主默认。 */
	borderWidth: number | null;
	/** 包围盒外扩边距（0.01 英寸），默认 40。 */
	margin: number;
}

export const DEFAULT_PLACEMENT_SETTINGS: PlacementSettings = {
	gapX: 80,
	gapY: 80,
	borderColor: '',
	borderWidth: null,
	margin: 40,
};

interface SysStorageApi {
	/** 官方 sys_Storage 签名：get 同步返回任意值（key 不存在为 undefined）；set 返回 Promise<boolean>。 */
	getExtensionUserConfig?: (k: string) => unknown;
	setExtensionUserConfig?: (k: string, v: string) => Promise<boolean>;
}

function storage(): SysStorageApi | undefined {
	return (edaGlobal()?.sys_Storage ?? undefined) as SysStorageApi | undefined;
}

function lsGet(key: string): string {
	try {
		const v = localStorage?.getItem(LS_PREFIX + key);
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}
function lsSet(key: string, val: string): void {
	try {
		localStorage?.setItem(LS_PREFIX + key, val);
	}
	catch { /* 主进程无 localStorage */ }
}
function sysGet(key: string): string {
	try {
		const v = storage()?.getExtensionUserConfig?.(key);
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}
function sysSet(key: string, val: string): void {
	try {
		// 官方签名返回 Promise<boolean>：不处理会产生 unhandled rejection，显式吞掉
		// （设置落盘尽力而为；设置保存是同步桥方法，异步失败无法同步感知）。
		void Promise.resolve(storage()?.setExtensionUserConfig?.(key, val)).catch(() => { /* 尽力而为 */ });
	}
	catch { /* 独立脚本环境无 sys_Storage */ }
}

export function getLlmSettings(): LlmSettings {
	return {
		provider: parseProvider(lsGet(K_PROVIDER) || sysGet(K_PROVIDER) || 'openai-chat'),
		baseUrl: lsGet(K_BASE) || sysGet(K_BASE),
		apiKey: lsGet(K_KEY) || sysGet(K_KEY),
		model: lsGet(K_MODEL) || sysGet(K_MODEL),
	};
}

export function saveLlmSettings(s: LlmSettings): void {
	const provider = parseProvider(s.provider);
	lsSet(K_PROVIDER, provider);
	sysSet(K_PROVIDER, provider);
	lsSet(K_BASE, s.baseUrl || '');
	sysSet(K_BASE, s.baseUrl || '');
	lsSet(K_KEY, s.apiKey || '');
	sysSet(K_KEY, s.apiKey || '');
	lsSet(K_MODEL, s.model || '');
	sysSet(K_MODEL, s.model || '');
}

export function getLibraryScope(): Record<string, boolean> {
	const raw = lsGet(K_SCOPE) || sysGet(K_SCOPE);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Record<string, boolean>;
			if (parsed && typeof parsed === 'object') {
				return {
					personal: parsed.personal !== false,
					team: parsed.team !== false,
					local: parsed.local !== false,
				};
			}
		}
		catch { /* 损坏则回退默认 */ }
	}
	return { personal: true, team: true, local: true };
}

export function saveLibraryScope(scope: Record<string, boolean>): void {
	const text = JSON.stringify({
		personal: scope?.personal !== false,
		team: scope?.team !== false,
		local: scope?.local !== false,
	});
	lsSet(K_SCOPE, text);
	sysSet(K_SCOPE, text);
}

export function getLocalLibraryPath(): string {
	return lsGet(K_LOCAL_PATH) || sysGet(K_LOCAL_PATH) || DEFAULT_LOCAL_LIBRARY_PATH;
}

export function saveLocalLibraryPath(path: string): void {
	const p = (path || '').trim();
	lsSet(K_LOCAL_PATH, p);
	sysSet(K_LOCAL_PATH, p);
}

export function getPlacementSettings(): PlacementSettings {
	const raw = lsGet(K_PLACE) || sysGet(K_PLACE);
	if (raw) {
		try {
			const p = JSON.parse(raw) as Partial<PlacementSettings>;
			const gap = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
			const color = typeof p.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(p.borderColor.trim()) ? p.borderColor.trim() : '';
			const width = Number.isFinite(Number(p.borderWidth)) && Number(p.borderWidth) > 0 ? Number(p.borderWidth) : null;
			return {
				gapX: gap(p.gapX, DEFAULT_PLACEMENT_SETTINGS.gapX),
				gapY: gap(p.gapY, DEFAULT_PLACEMENT_SETTINGS.gapY),
				borderColor: color,
				borderWidth: width,
				margin: Number.isFinite(Number(p.margin)) && Number(p.margin) >= 0 ? Number(p.margin) : DEFAULT_PLACEMENT_SETTINGS.margin,
			};
		}
		catch { /* 损坏则回退默认 */ }
	}
	return { ...DEFAULT_PLACEMENT_SETTINGS };
}

export function savePlacementSettings(s: PlacementSettings): void {
	const clean = getPlacementSettings();
	const text = JSON.stringify({
		gapX: s.gapX > 0 ? Number(s.gapX) : clean.gapX,
		gapY: s.gapY > 0 ? Number(s.gapY) : clean.gapY,
		borderColor: typeof s.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.borderColor.trim()) ? s.borderColor.trim() : '',
		borderWidth: Number.isFinite(Number(s.borderWidth)) && Number(s.borderWidth) > 0 ? Number(s.borderWidth) : null,
		margin: Number.isFinite(Number(s.margin)) && Number(s.margin) >= 0 ? Number(s.margin) : clean.margin,
	});
	lsSet(K_PLACE, text);
	sysSet(K_PLACE, text);
}

/** Jev（TypeSafe System One 决策模型）接入设置：与主 LLM 相互独立，各用各的 Key。恒启用——未配置 Key 时工具侧温和回落，无开关。 */
export interface JevSettings {
	apiKey: string;
	/** 官方默认 https://api.typesafe.ai/v1（填到 /v1 这级，与主 LLM baseUrl 同口径）。 */
	baseUrl: string;
	/** 默认 jev-latest（官方旗舰别名）。 */
	model: string;
}

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';
export const DEFAULT_JEV_MODEL = 'jev-latest';

const K_JEV_KEY = 'jev_api_key';
const K_JEV_BASE = 'jev_base_url';
const K_JEV_MODEL = 'jev_model';

export function getJevSettings(): JevSettings {
	return {
		apiKey: lsGet(K_JEV_KEY) || sysGet(K_JEV_KEY),
		baseUrl: lsGet(K_JEV_BASE) || sysGet(K_JEV_BASE) || DEFAULT_JEV_BASE_URL,
		model: lsGet(K_JEV_MODEL) || sysGet(K_JEV_MODEL) || DEFAULT_JEV_MODEL,
	};
}

export function saveJevSettings(s: JevSettings): void {
	lsSet(K_JEV_KEY, s.apiKey || '');
	sysSet(K_JEV_KEY, s.apiKey || '');
	lsSet(K_JEV_BASE, (s.baseUrl || '').trim());
	sysSet(K_JEV_BASE, (s.baseUrl || '').trim());
	lsSet(K_JEV_MODEL, (s.model || '').trim());
	sysSet(K_JEV_MODEL, (s.model || '').trim());
}

/** 用户自定义的风格与限制。未保存或保存为空时返回内置默认。 */
export function getStylePrompt(): string {
	const raw = lsGet(K_STYLE) || sysGet(K_STYLE);
	return raw.trim() || DEFAULT_STYLE_PROMPT;
}

export function getDefaultStylePrompt(): string {
	return DEFAULT_STYLE_PROMPT;
}

export function getStylePresets(): { rigorous: string; relaxed: string } {
	return { rigorous: STYLE_PRESET_RIGOROUS, relaxed: STYLE_PRESET_RELAXED };
}

export function saveStylePrompt(text: string): void {
	const v = (text || '').trim();
	lsSet(K_STYLE, v);
	sysSet(K_STYLE, v);
}
