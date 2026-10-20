import { edaGlobal, sleep, withTimeout } from './host';

export interface SelectionShortCircuitFlag {
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
}

type Primitive = Record<string, unknown>;

function state(primitive: Primitive, field: string): unknown {
	const getter = primitive[`getState_${field}`];
	return typeof getter === 'function' ? getter.call(primitive) : undefined;
}

function key(flag: SelectionShortCircuitFlag): string {
	return JSON.stringify([Math.round(flag.x * 1e6), Math.round(flag.y * 1e6), ((flag.rotation % 360) + 360) % 360, flag.mirror]);
}

async function readFlags(): Promise<Array<Primitive>> {
	const api = edaGlobal()?.sch_PrimitiveComponent as { getAll?: () => Promise<Array<Primitive>> } | undefined;
	if (typeof api?.getAll !== 'function')
		throw new Error('读取短接标识接口不可用');
	return (await withTimeout(api.getAll(), 10000, '读取短接标识超时')).filter(p => state(p, 'ComponentType') === 'short_symbol');
}

function position(primitive: Primitive): SelectionShortCircuitFlag {
	const x = state(primitive, 'X');
	const y = state(primitive, 'Y');
	const rotation = state(primitive, 'Rotation');
	const mirror = state(primitive, 'Mirror');
	if (typeof x !== 'number' || typeof y !== 'number' || typeof rotation !== 'number'
		|| ![x, y, rotation].every(Number.isFinite) || typeof mirror !== 'boolean') {
		throw new Error('短接标识的位置或方向读取失败');
	}
	return { x, y, rotation, mirror };
}

export async function verifyShortCircuitFlags(expected: Array<SelectionShortCircuitFlag>): Promise<void> {
	if (!expected.length)
		return;
	const wanted = new Map<string, number>();
	for (const flag of expected)
		wanted.set(key(flag), (wanted.get(key(flag)) || 0) + 1);
	const actual = await readFlags();
	for (const flag of actual) {
		const k = key(position(flag));
		const count = wanted.get(k) || 0;
		if (!count)
			throw new Error('短接标识重建后位置、方向或数量与原图不一致');
		wanted.set(k, count - 1);
	}
	if ([...wanted.values()].some(count => count > 0))
		throw new Error('短接标识未完整重建');
}

/** create 的返回对象可能为空，必须回读确认；短接标识失败时阻止保存残缺模块。 */
export async function rebuildShortCircuitFlags(flags: Array<SelectionShortCircuitFlag>): Promise<number> {
	if (!flags.length)
		return 0;
	const api = edaGlobal()?.sch_PrimitiveComponent as {
		createShortCircuitFlag?: (x: number, y: number, rotation: number, mirror: boolean) => Promise<unknown>;
	} | undefined;
	if (typeof api?.createShortCircuitFlag !== 'function')
		throw new Error('短接标识重建接口 createShortCircuitFlag 不可用');
	for (const flag of flags) {
		const before = new Set((await readFlags()).map(p => state(p, 'PrimitiveId')));
		await withTimeout(api.createShortCircuitFlag(flag.x, flag.y, flag.rotation, flag.mirror), 15000, '重建短接标识超时');
		const made = (await readFlags()).find(p => !before.has(state(p, 'PrimitiveId')));
		if (!made)
			throw new Error(`短接标识未落到画布（${flag.x}, ${flag.y}）`);
		const actual = position(made);
		if (key(actual) !== key(flag)) {
			if (typeof made.setState_Rotation !== 'function' || typeof made.setState_Mirror !== 'function' || typeof made.done !== 'function')
				throw new Error('短接标识方向不一致且无法还原');
			made.setState_Rotation(flag.rotation);
			made.setState_Mirror(flag.mirror);
			await withTimeout(made.done() as Promise<unknown>, 15000, '还原短接标识方向超时');
		}
	}
	await sleep(500);
	await verifyShortCircuitFlags(flags);
	return flags.length;
}
