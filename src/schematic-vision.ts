import { edaGlobal, sleep, withTimeout } from './host';

export interface VisionImage {
	dataUrl: string;
	caption: string;
}

export interface ViewRegion {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export type SchematicView = 'page' | 'selection' | 'region' | 'viewport';
type Primitive = Record<string, unknown>;
let previousCapture: { page: string; region: string; hash: number } | undefined;

function state(p: Primitive, field: string): unknown {
	const fn = p[`getState_${field}`];
	return typeof fn === 'function' ? fn.call(p) : p[field[0].toLowerCase() + field.slice(1)];
}

/** 不依赖宿主缺失的 Buffer / btoa / FileReader。 */
export function imageBase64(bytes: Uint8Array): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const chunks: Array<string> = [];
	let chunk = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
		chunk += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63]
			+ (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=')
			+ (i + 2 < bytes.length ? alphabet[n & 63] : '=');
		if (chunk.length >= 8192) {
			chunks.push(chunk);
			chunk = '';
		}
	}
	return chunks.join('') + chunk;
}

export function validViewRegion(region: unknown): region is ViewRegion {
	const r = region as ViewRegion | undefined;
	return !!r && [r.left, r.right, r.top, r.bottom].every(Number.isFinite)
		&& r.right > r.left && r.bottom > r.top;
}

export async function captureSchematicView(view: SchematicView, region?: ViewRegion) {
	const root = edaGlobal();
	const docApi = root?.dmt_SelectControl as { getCurrentDocumentInfo?: () => Promise<{ documentType?: number; uuid?: string; tabId?: string }> } | undefined;
	const editor = root?.dmt_EditorControl as {
		getCurrentRenderedAreaImage?: (tabId?: string) => Promise<Blob | undefined>;
		zoomToAllPrimitives?: (tabId?: string) => Promise<ViewRegion | false | undefined>;
		zoomToRegion?: (left: number, right: number, top: number, bottom: number, tabId?: string) => Promise<boolean | undefined>;
	} | undefined;
	const select = root?.sch_SelectControl as { getAllSelectedPrimitives?: () => Promise<Array<Primitive>> } | undefined;
	if (typeof docApi?.getCurrentDocumentInfo !== 'function' || typeof select?.getAllSelectedPrimitives !== 'function'
		|| typeof editor?.getCurrentRenderedAreaImage !== 'function') {
		throw new TypeError('当前客户端缺少原理图截图接口，请升级嘉立创EDA后重试');
	}
	const doc = await docApi.getCurrentDocumentInfo();
	if (doc?.documentType !== 1 || !doc.uuid || !doc.tabId)
		throw new Error('请先打开要读取的原理图页');
	const tabId = doc.tabId;
	const selected = await select.getAllSelectedPrimitives();
	const components = selected.filter(p => typeof state(p, 'ComponentType') === 'string' && state(p, 'ComponentType') !== 'sheet').map(p => ({
		id: String(state(p, 'PrimitiveId') || ''),
		designator: String(state(p, 'Designator') || state(p, 'Name') || ''),
		kind: String(state(p, 'ComponentType')),
		x: state(p, 'X'),
		y: state(p, 'Y'),
	}));
	const wires = selected.filter(p => Array.isArray(state(p, 'Line'))).map(p => ({
		id: String(state(p, 'PrimitiveId') || ''),
		line: state(p, 'Line'),
	}));
	const fingerprint = (rows: Array<Primitive>) => rows.map(p => String(state(p, 'PrimitiveId') || '')).sort().join('|');
	if (view === 'selection' && !selected.length)
		throw new Error('当前选区为空，请先选择图元或读取整页');
	let bounds: ViewRegion | undefined;
	if (view === 'page') {
		if (typeof editor.zoomToAllPrimitives !== 'function')
			throw new Error('无法缩放到完整原理图');
		const result = await editor.zoomToAllPrimitives();
		if (result === false)
			throw new Error('无法缩放到完整原理图');
		if (validViewRegion(result))
			bounds = result;
	}
	if (view === 'selection') {
		const points: Array<{ x: number; y: number }> = [];
		for (const p of selected) {
			const line = state(p, 'Line');
			if (Array.isArray(line)) {
				const flat = line.flat() as Array<number>;
				for (let i = 0; i + 1 < flat.length; i += 2)
					points.push({ x: flat[i], y: flat[i + 1] });
			}
			else if (state(p, 'ComponentType') !== 'sheet') {
				points.push({ x: Number(state(p, 'X')), y: Number(state(p, 'Y')) });
			}
		}
		const pins = root?.sch_PrimitiveComponent as { getAllPinsByPrimitiveId?: (id: string) => Promise<Array<{ x: number; y: number }>> } | undefined;
		if (typeof pins?.getAllPinsByPrimitiveId === 'function') {
			const readPins = pins.getAllPinsByPrimitiveId.bind(pins);
			const lists = await Promise.all(components.filter(c => c.kind === 'part').slice(0, 80).map(c => withTimeout(readPins(c.id), 8000, '读取选区引脚超时')));
			for (const list of lists)
				points.push(...(list || []));
		}
		const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
		if (!valid.length)
			throw new Error('无法确定当前选区的位置');
		bounds = { left: Math.min(...valid.map(p => p.x)), right: Math.max(...valid.map(p => p.x)), top: Math.min(...valid.map(p => p.y)), bottom: Math.max(...valid.map(p => p.y)) };
		// 保留邻近电路，模型才看得到选区之外遗漏的器件。
		const dx = Math.max(30, (bounds.right - bounds.left) * 0.2);
		const dy = Math.max(30, (bounds.bottom - bounds.top) * 0.2);
		region = { left: bounds.left - dx, right: bounds.right + dx, top: bounds.top - dy, bottom: bounds.bottom + dy };
	}
	if (view === 'region' || view === 'selection') {
		if (!validViewRegion(region))
			throw new Error('局部读图需要有效的 left/right/top/bottom 范围');
		// 编辑器以向上的 Y 轴解释 top/bottom；工具范围统一为 top=minY、bottom=maxY。
		if (typeof editor.zoomToRegion !== 'function' || await editor.zoomToRegion(region.left, region.right, region.bottom, region.top) === false)
			throw new Error('无法缩放到指定电路区域');
		bounds = region;
	}
	await sleep(300);
	const blob = await withTimeout(editor.getCurrentRenderedAreaImage(), 15000, '读取原理图图像超时');
	if (!blob || typeof blob.arrayBuffer !== 'function')
		throw new Error('宿主未返回原理图图像');
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > 4 * 1024 * 1024)
		throw new Error('截图格式不支持或超过 4 MiB，请缩小区域后重试');
	const bytes = new Uint8Array(await blob.arrayBuffer());
	if (!bytes.length)
		throw new Error('宿主返回了空图像');
	const current = await docApi.getCurrentDocumentInfo();
	if (current?.uuid !== doc.uuid || current.tabId !== tabId)
		throw new Error('截图期间图页已切换，请重新读取');
	if (fingerprint(selected) !== fingerprint(await select.getAllSelectedPrimitives()))
		throw new Error('截图期间选区已变化，请重新核对');
	let hash = 2166136261;
	for (const byte of bytes)
		hash = Math.imul(hash ^ byte, 16777619);
	const regionKey = bounds ? JSON.stringify(bounds) : view === 'page' ? 'page' : '';
	if (regionKey && previousCapture?.region && previousCapture.page === doc.uuid
		&& previousCapture.region !== regionKey && previousCapture.hash === hash) {
		throw new Error('画布图像未随缩放刷新。请把嘉立创EDA窗口置前并点击窗口标题栏，保持画布可见后重新读图');
	}
	previousCapture = { page: doc.uuid, region: regionKey, hash };
	const png = blob.type === 'image/png' && bytes.length >= 24;
	const width = png ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) : undefined;
	const height = png ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) : undefined;
	return {
		image: { dataUrl: `data:${blob.type};base64,${imageBase64(bytes)}`, caption: `原理图${view === 'selection' ? '选区与周边' : view === 'page' ? '整页' : '局部'}截图；实际选中状态以回读清单为准；检查器件后，另逐项核对 GND/电源标志、网络端口、导线标签及连接线。同名标志按 id 和位置区分，图上可见不代表已选中。` } satisfies VisionImage,
		observation: {
			pageUuid: doc.uuid,
			view,
			requestedRegion: bounds,
			width,
			height,
			selection: { components, wires, wireCount: wires.length, total: selected.length },
		},
	};
}
