import type { JevSettings } from '../settings';
import type { CatalogStoreRecord, FlatModule } from './store';
/**
 * Jev 语义推荐（TypeSafe System One 决策模型，不生成文本、只输出类型化决策）。
 * 三阶段机制，全部是对 /systemone 端点的类型化决策调用：
 * ① 预设分类：目录全量模块（name+description）按预设类别做 choice 分类，
 *    结果以「目录 fetchedAt + 类别集」为键缓存（jev_classify.v1），目录刷新自动重建；
 * ② 类别布尔筛选：对每个预设类别逐一 noul 判断「该需求是否需要此类模块」；
 * ③ 类内全量打分：所需类别下的全部模块逐个 score（6 级量规 0-5 → 线性映射 0-10），按分排序返回 top N。
 *
 * 出站复用 sendLlmRequest（sys_ClientUrl 嘉立创代理 + 错误分类），非流式。
 * 请求/响应字段对照官方 docs.typesafe.ai/api（2026-09-20 核对）：
 * question = { type: noul|choice|score, instructions: string|object, criteria? }；
 * answer = noul{noul} | choice{choice,probabilities,confidence} | score{score,legend,probabilities,confidence}。
 */
import { edaGlobal } from '../host';
import { classifyLlmError, sendLlmRequest } from './http';
import { flattenCatalog } from './store';

// ── 预设分类（代码内固定；改标签即触发分类缓存整体重建） ──────────────

export interface JevCategory {
	id: string;
	label: string;
	hint: string;
}

export const JEV_CATEGORIES: Array<JevCategory> = [
	{ id: 'power', label: '电源', hint: 'LDO/DCDC/充电管理等电压转换与供电电路' },
	{ id: 'mcu', label: 'MCU最小系统', hint: '单片机/处理器最小系统、核心板、下载调试' },
	{ id: 'interface', label: '接口总线', hint: 'USB/UART/以太网 PHY/电平转换/隔离' },
	{ id: 'storage', label: '存储', hint: 'SD卡/eMMC/Flash/SRAM 存储电路' },
	{ id: 'wireless', label: '无线通信', hint: 'WiFi/蓝牙/LoRa/4G/NB-IoT 模块与天线' },
	{ id: 'analog', label: '模拟传感', hint: '运放/ADC/DAC/传感器信号采集前端' },
	{ id: 'motor', label: '驱动执行', hint: '电机驱动/继电器/功率器件驱动' },
	{ id: 'display', label: '显示人机', hint: 'LCD/OLED 屏、按键、指示灯等人机交互' },
	{ id: 'audio', label: '音频', hint: '功放/编解码/麦克风/扬声器电路' },
	{ id: 'misc', label: '其他', hint: '时钟、复位、保护、滤波等通用电路' },
];

/** choice 选项上限 255（官方口径）；10 个标签远在界内，仅防手滑超限。 */
function assertCategoryLimit(): void {
	if (JEV_CATEGORIES.length > 255)
		throw new Error('JEV_CATEGORIES 超出 choice 选项上限（255）');
}

// ── 决策问题与答案（官方三原语：noul 布尔 / choice 选择 / score 量规） ─

/** 官方 Question：instructions 必填；criteria 按原语各异（noul={true,false} 描述、choice={选项:描述|null}、score=有序级别数组 2~10 级）。 */
interface JevQuestion {
	type: 'noul' | 'choice' | 'score';
	instructions: string;
	criteria?: Record<string, string | null> | Array<string>;
}

/** 解析后的单个答案：三原语统一形态（未出现的字段为 undefined）。 */
export interface JevAnswer {
	choice?: string;
	/** score 的量规插值（级别下标，0 起）。 */
	level?: number;
	/** noul 的「是」概率（0-1）。 */
	prob?: number;
	/** choice/score 自带的校准置信度（0-1）；noul 无此字段，按 1 处理。 */
	confidence: number;
}

/** Score 量规：6 级（官方上限 10 级），0-5 级线性映射到 0-10 分展示。 */
const SCORE_LEVELS = ['与需求无关', '仅少量沾边', '部分相关', '比较匹配', '高度匹配', '精确匹配'];

function levelToScore10(level: number): number {
	const clamped = Math.min(Math.max(level, 0), SCORE_LEVELS.length - 1);
	return Math.round((clamped / (SCORE_LEVELS.length - 1)) * 100) / 10;
}

/**
 * [适配点 1/2] 请求构造：POST {baseUrl}/systemone，Bearer 鉴权。
 * body 三段：model / state（待评估的应用状态，字符串或 JSON）/ questions（命名问题表，同请求内并行评估）。
 */
async function jevEvaluate(settings: JevSettings, state: string | Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
	const base = (settings.baseUrl || 'https://api.typesafe.ai/v1').trim().replace(/\/+$/, '');
	const url = base.endsWith('/systemone') ? base : `${base}/systemone`;
	if (!settings.apiKey.trim())
		throw new Error('尚未配置 Jev API Key：请到 设置 → Jev 语义推荐 填入');
	const body = {
		model: (settings.model || 'jev-latest').trim(),
		state,
		questions,
	};
	const raw = await sendLlmRequest({
		url,
		body: JSON.stringify(body),
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey.trim()}` },
	});
	return parseJevAnswers(raw, Object.keys(questions));
}

/**
 * [适配点 2/2] 响应解析（官方契约）：{ answers: { <id>: Answer } }。
 * noul → noul 字段；choice → choice/probabilities/confidence；score → score/confidence。
 * 保留少量容错（缺字段/异常类型按空答案处理），不猜别名。
 */
function parseJevAnswers(raw: unknown, names: Array<string>): Record<string, JevAnswer> {
	const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const map = (root.answers && typeof root.answers === 'object' ? root.answers : root) as Record<string, unknown>;
	const out: Record<string, JevAnswer> = {};
	const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
	for (const name of names) {
		const a = map[name] as Record<string, unknown> | undefined;
		if (!a || typeof a !== 'object') {
			out[name] = { confidence: 0 };
			continue;
		}
		const type = String(a.type || '');
		if (type === 'noul' || num(a.noul) !== undefined) {
			out[name] = { prob: num(a.noul) ?? 0, confidence: 1 };
			continue;
		}
		if (type === 'choice' || typeof a.choice === 'string') {
			out[name] = { choice: String(a.choice || ''), confidence: num(a.confidence) ?? 0 };
			continue;
		}
		if (type === 'score' || num(a.score) !== undefined) {
			out[name] = { level: num(a.score) ?? 0, confidence: num(a.confidence) ?? 0 };
			continue;
		}
		out[name] = { confidence: 0 };
	}
	return out;
}

// ── 分类缓存（jev_classify.v1）：目录 fetchedAt + 类别集 变化即整体重建 ──

const JEV_STORE_KEY = 'jev_classify.v1';
const JEV_CLASSIFY_VERSION = '1';

interface JevClassifyRecord {
	formatVersion: string;
	/** 生成时的目录 fetchedAt：目录刷新（时间戳变化）后分类整体重建。 */
	catalogFetchedAt: number;
	/** 分类时的类别标签集（join 校验串；改预设类别即失效）。 */
	categoriesKey: string;
	classifiedAt: number;
	/** uuid → 类别标签 + 置信度。 */
	items: Record<string, { category: string; confidence: number }>;
}

function sysGet(key: string): string {
	try {
		const v = (edaGlobal()?.sys_Storage as { getExtensionUserConfig?: (k: string) => unknown } | undefined)?.getExtensionUserConfig?.(key);
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}

/** 缓存写尽力而为：写失败只降级为本次会话内存有效（cache 用途，不该拖垮推荐主流程）。 */
function sysSetBestEffort(key: string, val: string): void {
	try {
		void Promise.resolve((edaGlobal()?.sys_Storage as { setExtensionUserConfig?: (k: string, v: string) => Promise<boolean> } | undefined)?.setExtensionUserConfig?.(key, val))
			.catch(e => console.warn('[cbb-copilot] Jev 分类缓存落盘失败（本次会话仍可用）:', e));
	}
	catch { /* 尽力而为 */ }
}

let memoryClassify: JevClassifyRecord | null = null;

function classifyKeyOf(fetchedAt: number): string {
	return `${fetchedAt}|${JEV_CATEGORIES.map(c => c.label).join(',')}`;
}

function loadClassifyRecord(catalogRec: CatalogStoreRecord): Map<string, { category: string; confidence: number }> {
	const key = classifyKeyOf(catalogRec.fetchedAt);
	if (memoryClassify && memoryClassify.formatVersion === JEV_CLASSIFY_VERSION && classifyKeyOf(memoryClassify.catalogFetchedAt) === key)
		return new Map(Object.entries(memoryClassify.items));
	if (memoryClassify)
		memoryClassify = null;
	const raw = sysGet(JEV_STORE_KEY);
	if (raw) {
		try {
			const rec = JSON.parse(raw) as JevClassifyRecord;
			if (rec && rec.formatVersion === JEV_CLASSIFY_VERSION && `${rec.catalogFetchedAt}|${rec.categoriesKey}` === key && rec.items) {
				memoryClassify = rec;
				return new Map(Object.entries(rec.items));
			}
		}
		catch { /* 损坏视为缺失 */ }
	}
	return new Map();
}

function saveClassifyRecord(catalogRec: CatalogStoreRecord, items: Record<string, { category: string; confidence: number }>): void {
	const rec: JevClassifyRecord = {
		formatVersion: JEV_CLASSIFY_VERSION,
		catalogFetchedAt: catalogRec.fetchedAt,
		categoriesKey: JEV_CATEGORIES.map(c => c.label).join(','),
		classifiedAt: Date.now(),
		items,
	};
	memoryClassify = rec;
	sysSetBestEffort(JEV_STORE_KEY, JSON.stringify(rec));
}

// ── 阶段 ①：全量分类（choice，按批并行入请求、串行批间） ──────────────

/** 每批模块数：一批一个 /systemone 请求（state.modules + 每模块一个 choice 问题，同请求并行评估）。 */
const CLASSIFY_BATCH = 16;

function descBrief(m: FlatModule, max: number): string {
	return (m.description || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function classifyMissing(
	settings: JevSettings,
	modules: Array<FlatModule>,
	cache: Map<string, { category: string; confidence: number }>,
): Promise<void> {
	assertCategoryLimit();
	const criteria: Record<string, string | null> = {};
	for (const c of JEV_CATEGORIES)
		criteria[c.label] = c.hint;
	const missing = modules.filter(m => !cache.has(m.uuid));
	for (let i = 0; i < missing.length; i += CLASSIFY_BATCH) {
		const batch = missing.slice(i, i + CLASSIFY_BATCH);
		const state = { modules: batch.map((m, k) => ({ i: k, name: m.name || '', desc: descBrief(m, 200) })) };
		const questions: Record<string, JevQuestion> = {};
		for (let k = 0; k < batch.length; k++)
			questions[`m${k}`] = { type: 'choice', instructions: `模块 \`modules[${k}]\` 属于哪个类别？只看功能用途，不属于任何明确类别时选「其他」。`, criteria };
		const answers = await jevEvaluate(settings, state, questions);
		for (let k = 0; k < batch.length; k++) {
			const a = answers[`m${k}`];
			const label = a?.choice && criteria[a.choice] !== undefined ? a.choice : '其他';
			cache.set(batch[k]!.uuid, { category: label, confidence: a?.confidence ?? 0 });
		}
	}
}

// ── 阶段 ②：类别布尔筛选（每个预设类别一个 noul 问题，单请求并行） ─────

export interface JevNeededCategory {
	id: string;
	label: string;
	/** 「需要」概率。 */
	prob: number;
}

/**
 * 筛类参数：0.5 硬切会误杀复合需求（实测「我想做一个循迹小车」把隐含的 传感/电源 类
 * 判 ≤0.5 整体出局，导致核心传感器模块从未进入打分池）——改为概率下限；
 * 通过下限的类别全部保留，不再截 top-M（最多即为预设类别全集，当前 10 个）。
 */
const CATEGORY_PROB_MIN = 0.3;

async function selectCategories(settings: JevSettings, query: string): Promise<Array<JevNeededCategory>> {
	assertCategoryLimit();
	const questions: Record<string, JevQuestion> = {};
	for (const c of JEV_CATEGORIES) {
		questions[`cat_${c.id}`] = {
			type: 'noul',
			instructions: `完成用户需求「${query}」需要用到「${c.label}」类模块吗？`,
			criteria: {
				true: '需求涉及该类别——包括明确提及，也包括由需求整体推断出的子系统（整机类需求如小车/机器人/开发板，通常隐含主控、电机驱动、传感、电源中的多项）',
				false: '需求明确不涉及该类别',
			},
		};
	}
	const answers = await jevEvaluate(settings, query, questions);
	const judged: Array<JevNeededCategory> = [];
	for (const c of JEV_CATEGORIES) {
		const prob = answers[`cat_${c.id}`]?.prob ?? 0;
		if (prob > CATEGORY_PROB_MIN)
			judged.push({ id: c.id, label: c.label, prob });
	}
	judged.sort((a, b) => b.prob - a.prob);
	return judged;
}

// ── 阶段 ③：类内全量打分（score 6 级量规 → 0-10，按批） ───────────────

const SCORE_BATCH = 16;

export interface JevRecommendHit {
	module: FlatModule;
	category: string;
	/** 需求匹配分（量规 0-5 级线性映射到 0-10）。 */
	score: number;
	confidence: number;
}

async function scoreModules(settings: JevSettings, query: string, candidates: Array<FlatModule>, categoryOf: Map<string, { category: string; confidence: number }>): Promise<Array<JevRecommendHit>> {
	const scored: Array<JevRecommendHit> = [];
	for (let i = 0; i < candidates.length; i += SCORE_BATCH) {
		const batch = candidates.slice(i, i + SCORE_BATCH);
		const state = { requirement: query, modules: batch.map((m, k) => ({ i: k, name: m.name || '', desc: descBrief(m, 300) })) };
		const questions: Record<string, JevQuestion> = {};
		for (let k = 0; k < batch.length; k++)
			questions[`s${k}`] = { type: 'score', instructions: `模块 \`modules[${k}]\` 对需求 \`requirement\` 的匹配程度。`, criteria: SCORE_LEVELS };
		const answers = await jevEvaluate(settings, state, questions);
		for (let k = 0; k < batch.length; k++) {
			const a = answers[`s${k}`];
			const score = levelToScore10(a?.level ?? 0);
			if (score <= 0)
				continue;
			scored.push({
				module: batch[k]!,
				category: categoryOf.get(batch[k]!.uuid)?.category || '其他',
				score,
				confidence: a?.confidence ?? 0,
			});
		}
	}
	scored.sort((x, y) => y.score - x.score || y.confidence - x.confidence);
	return scored;
}

// ── 阶段 ④：放置意图判定（place 布尔 + target 选择 + 形式布尔，单请求并行） ──

export interface JevPlacementIntent {
	/** 高置信放置意图（prob > PLACE_INTENT_MIN）时才允许自动出卡。 */
	place: boolean;
	/** 「想放置」的原始概率（未阈值化），供 LLM 参考决定是否补出卡。 */
	prob: number;
	/** 放置位置：current 当前图页 / new 新建图页 / board 新板子 / project 新工程。 */
	target: 'current' | 'new' | 'board' | 'project';
	/** 用户明确要求用「复用模块图页」形式（默认模块符号）。 */
	pageMode: boolean;
}

/**
 * 自动出卡的意图阈值：0.5 过敏——实测「我想做一个循迹小车」这类项目意愿表达也会过线，
 * 卡片即刻弹出、agent 显得越权放置。0.8 + 严格 criteria（明确操作指令）才自动出卡；
 * 未达线的场景返回明细与 placement 参考，由 LLM 决定出卡或先给文字方案。
 */
const PLACE_INTENT_MIN = 0.8;

/** target choice 与 propose_placement 规则 8 的口径一致（成对维护）。 */
async function judgePlacementIntent(settings: JevSettings, query: string): Promise<JevPlacementIntent> {
	const answers = await jevEvaluate(settings, query, {
		place: {
			type: 'noul',
			instructions: '用户是否明确要求把这些模块放置到原理图/工程里？',
			criteria: {
				true: '明确的放置操作指令（如「放一个」「放到当前图页」「帮我放上」「推荐并放置」）',
				false: '仅询问/比较/了解模块，或只是表达项目意愿（如「我想做一个××」）而未明确要求放置',
			},
		},
		target: {
			type: 'choice',
			instructions: '若用户想放置，放置到哪里？',
			criteria: { current: '当前图页（用户未特别说明位置时选这个）', new: '用户要求单独一页/新建图页', board: '用户要求新板子/新原理图', project: '用户要求新建工程' },
		},
		page: {
			type: 'noul',
			instructions: '用户是否明确要求用「复用模块图页」形式放置（而非默认的模块符号）？',
			criteria: { true: '明确说了用图页/复用模块图/整页放置', false: '未提形式（默认符号），或明确说了用符号' },
		},
	});
	const targetRaw = answers.target?.choice || 'current';
	const target = (['current', 'new', 'board', 'project'] as const).includes(targetRaw as 'current') ? targetRaw as JevPlacementIntent['target'] : 'current';
	const placeProb = answers.place?.prob ?? 0;
	return {
		place: placeProb > PLACE_INTENT_MIN,
		prob: placeProb,
		target,
		pageMode: (answers.page?.prob ?? 0) > 0.5,
	};
}

// ── 编排：四阶段串联 ─────────────────────────────────────────────────

export interface JevRecommendResult {
	hits: Array<JevRecommendHit>;
	/** 需求命中的类别（含概率），供工具结果回显。 */
	neededCategories: Array<JevNeededCategory>;
	/** 打分池内各类别命中数（选取前统计），供结果回显与排障。 */
	categoryHits: Array<{ category: string; count: number }>;
	/** 放置意图判定结果；无候选时不判定，为 null。 */
	placement: JevPlacementIntent | null;
	/** 缓存外新分类的模块数（首次调用约等于全量）。 */
	freshClassified: number;
	scored: number;
	elapsedMs: number;
}

/** 打分池按类别计数（降序）。 */
function countByCategory(hits: Array<JevRecommendHit>): Array<{ category: string; count: number }> {
	const m = new Map<string, number>();
	for (const h of hits)
		m.set(h.category, (m.get(h.category) || 0) + 1);
	return [...m.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/**
 * 跨类别轮转选取（每类先取第 1 名，再取第 2 名……直至 limit）：
 * 全局 top-K 会被同一功能位置的备选挤满（实测 5 席中 4 席是互为替代的电机驱动），
 * 轮转保证系统级需求（主控/驱动/传感/电源）各槽位都有代表。类别出场顺序按其最高分。
 */
function selectDiverse(hits: Array<JevRecommendHit>, limit: number): Array<JevRecommendHit> {
	const groups = new Map<string, Array<JevRecommendHit>>();
	for (const h of hits) {
		const g = groups.get(h.category);
		if (g)
			g.push(h);
		else
			groups.set(h.category, [h]);
	}
	for (const g of groups.values())
		g.sort((x, y) => y.score - x.score || y.confidence - x.confidence);
	const cats = [...groups.keys()].sort((a, b) => groups.get(b)![0]!.score - groups.get(a)![0]!.score);
	const out: Array<JevRecommendHit> = [];
	for (let round = 0; out.length < limit; round++) {
		let picked = false;
		for (const c of cats) {
			const g = groups.get(c)!;
			if (round < g.length && out.length < limit) {
				out.push(g[round]!);
				picked = true;
			}
		}
		if (!picked)
			break;
	}
	return out;
}

/**
 * Jev 语义推荐主入口：分类（缓存优先）→ 类别布尔筛选 → 类内全量打分。
 * 任一阶段失败直接抛出（调用方 catch 后降级到 search_modules）。
 */
export async function recommendModules(settings: JevSettings, catalogRec: CatalogStoreRecord, query: string, limit: number): Promise<JevRecommendResult> {
	const startedAt = Date.now();
	const flat = flattenCatalog(catalogRec.catalog);
	if (!flat.length)
		throw new Error('目录为空：请先 refresh_catalog 拉取模块目录');
	const cache = loadClassifyRecord(catalogRec);
	const before = cache.size;
	await classifyMissing(settings, flat, cache);
	const freshClassified = cache.size - before;
	if (freshClassified > 0) {
		const items: Record<string, { category: string; confidence: number }> = {};
		for (const [uuid, v] of cache)
			items[uuid] = v;
		saveClassifyRecord(catalogRec, items);
	}
	const needed = await selectCategories(settings, query);
	if (!needed.length) {
		return { hits: [], neededCategories: [], categoryHits: [], placement: null, freshClassified, scored: 0, elapsedMs: Date.now() - startedAt };
	}
	const neededLabels = new Set(needed.map(c => c.label));
	const candidates = flat.filter(m => neededLabels.has(cache.get(m.uuid)?.category || '其他'));
	const hits = candidates.length ? await scoreModules(settings, query, candidates, cache) : [];
	if (!hits.length) {
		return { hits: [], neededCategories: needed, categoryHits: [], placement: null, freshClassified, scored: candidates.length, elapsedMs: Date.now() - startedAt };
	}
	const categoryHits = countByCategory(hits);
	const placement = await judgePlacementIntent(settings, query);
	return {
		hits: selectDiverse(hits, limit),
		neededCategories: needed,
		categoryHits,
		placement,
		freshClassified,
		scored: candidates.length,
		elapsedMs: Date.now() - startedAt,
	};
}

// ── 连接测试：最小 noul 评估（校验 baseUrl / Key / model 全链路），耗时回显 ──

/** Jev 链路的失败恢复话术（设置页入口与主 LLM 不同，文案指向 Jev 区块）。 */
function jevRecoverySpeech(kind: string, message: string): string {
	switch (kind) {
		case 'auth':
			return '鉴权失败——Jev API Key 无效或已过期，请检查 设置 → Jev 语义推荐。';
		case 'path':
			return 'HTTP 404——Jev baseUrl 路径不对，应填到 /v1 这级（如 https://api.typesafe.ai/v1）。';
		case 'rate':
			return '请求被限流（429），请稍后重试。';
		case 'timeout':
			return '请求超时（120s）——请检查网络或代理可达性。';
		case 'format':
			return '响应不是合法 JSON——baseUrl 可能指向了非 API 地址。';
		case 'permission':
			return '无法出网：外部交互权限未开启，请在扩展管理中为本插件启用「外部交互权限」。';
		case 'unconfigured':
			return '尚未填写 Jev API Key。';
		default:
			return message;
	}
}

/** 设置页「测试连接」：发一个恒真的 noul 问题（1=1），有概率答案即视为链路通。 */
export async function testJevConnection(settings: JevSettings): Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }> {
	const model = (settings.model || 'jev-latest').trim();
	if (!settings.apiKey.trim())
		return { ok: false, model, latencyMs: 0, error: jevRecoverySpeech('unconfigured', '') };
	const startedAt = Date.now();
	try {
		const answers = await jevEvaluate(settings, '这是一个连通性测试。', {
			t: { type: 'noul', instructions: '请判断以下陈述是否为真：1 等于 1。' },
		});
		if (answers.t?.prob === undefined)
			throw new Error('响应缺少 noul 答案字段（端点返回了非预期结构）');
		return { ok: true, model, latencyMs: Date.now() - startedAt };
	}
	catch (e) {
		const { kind, message } = classifyLlmError(e);
		return { ok: false, model, latencyMs: Date.now() - startedAt, error: jevRecoverySpeech(kind, message) };
	}
}
