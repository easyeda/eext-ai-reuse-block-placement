import { edaGlobal, sleep, withTimeout } from './host';

type Primitive = Record<string, unknown>;

export interface SelectionNetLabel {
	net: string;
	x: number;
	y: number;
}

function state(primitive: Primitive, field: string): unknown {
	const getter = primitive[`getState_${field[0].toUpperCase()}${field.slice(1)}`];
	return typeof getter === 'function' ? getter.call(primitive) : primitive[field];
}

export function wireNetLabelState(attribute: Primitive): { id: string; value: string; visible: boolean } {
	const key = state(attribute, 'key');
	const value = String(state(attribute, 'value') ?? '');
	return {
		id: String(state(attribute, 'primitiveId') ?? ''),
		value,
		visible: (key === 'Name' || key === 'NET')
			&& ((state(attribute, 'valueVisible') === true && !!value) || state(attribute, 'keyVisible') === true),
	};
}

export function netLabelKey(label: SelectionNetLabel): string {
	return JSON.stringify([label.net, Math.round(label.x * 1e6), Math.round(label.y * 1e6)]);
}

/** 只读取属于导线的非空标签，电源标志、端口和器件名称不计入。 */
export async function readWireNetLabels(): Promise<Array<SelectionNetLabel>> {
	const root = edaGlobal();
	const wire = root?.sch_PrimitiveWire as { getAll?: () => Promise<Array<Primitive>> } | undefined;
	const attr = root?.sch_PrimitiveAttribute as { getAll?: () => Promise<Array<Primitive>> } | undefined;
	if (typeof wire?.getAll !== 'function' || typeof attr?.getAll !== 'function')
		throw new Error('读取走线网络标签的接口不可用');
	const ids = new Set((await withTimeout(wire.getAll(), 10000, '读取模块走线超时')).map(w => String(state(w, 'primitiveId') ?? '')));
	ids.delete('');
	const result: Array<SelectionNetLabel> = [];
	for (const a of await withTimeout(attr.getAll(), 10000, '读取走线属性超时')) {
		if (!ids.has(String(state(a, 'parentPrimitiveId') ?? '')))
			continue;
		const label = wireNetLabelState(a);
		if (!label.visible || !label.value)
			continue;
		const x = state(a, 'x');
		const y = state(a, 'y');
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
			throw new Error('网络标签坐标读取失败');
		result.push({ net: label.value, x, y });
	}
	return result;
}

/** 保存后按名称、位置、数量核对原图标签；不依赖不能持久化的属性隐藏操作。 */
export async function saveModuleWithWireNetLabels(expected: Array<SelectionNetLabel>): Promise<void> {
	const doc = edaGlobal()?.sch_Document as { save?: () => Promise<boolean> } | undefined;
	if (typeof doc?.save !== 'function')
		throw new Error('sch_Document.save 不可用');
	await sleep(800);
	if (await withTimeout(doc.save(), 20000, '保存模块超时（20s）') !== true)
		throw new Error('保存模块失败（接口返回 false）');
	await sleep(1200);
	const wanted = new Map<string, number>();
	for (const label of expected) {
		const key = netLabelKey(label);
		wanted.set(key, (wanted.get(key) || 0) + 1);
	}
	const actual = await readWireNetLabels();
	for (const label of actual) {
		const key = netLabelKey(label);
		const count = wanted.get(key) || 0;
		if (!count)
			throw new Error(`重建后出现原图没有的网络标签：${label.net}（${label.x}, ${label.y}）`);
		wanted.set(key, count - 1);
	}
	const missing = [...wanted.values()].reduce((sum, count) => sum + count, 0);
	if (missing)
		throw new Error(`原图网络标签未完整重建：缺少 ${missing} 个`);
}
