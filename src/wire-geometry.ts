import type { SelectionWire } from './cbb';

interface Segment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	net: string;
}

const EPS = 1e-5;

/** getAll 的逻辑导线是独立线段平铺，每四个数一段；不同于 create 的连续折线路径。 */
export function logicalWireSegments(wires: Array<SelectionWire>): Array<SelectionWire> {
	return wires.flatMap((wire) => {
		if (!Array.isArray(wire.line))
			throw new Error('逻辑导线的线段坐标格式无效，请重新读取原理图');
		const paths = Array.isArray(wire.line[0]) ? wire.line as Array<Array<number>> : [wire.line as Array<number>];
		return paths.flatMap((path) => {
			if (!Array.isArray(path) || path.length % 4 !== 0)
				throw new Error('逻辑导线的线段坐标格式无效，请重新读取原理图');
			const result: Array<SelectionWire> = [];
			for (let i = 0; i + 3 < path.length; i += 4) {
				const line = path.slice(i, i + 4);
				if (!line.every(Number.isFinite))
					throw new Error('逻辑导线包含无效坐标');
				if (Math.hypot(line[2] - line[0], line[3] - line[1]) > EPS)
					result.push({ ...wire, line });
			}
			return result;
		});
	});
}

/** 选区接口的分段 net 可能串到其他网络，以整页逻辑导线的几何归属为准。 */
export function resolveSelectedWireNets(selected: Array<SelectionWire>, logical: Array<SelectionWire>): Array<SelectionWire> {
	const parents = logical.map(wire => ({ net: wire.net, segments: logicalWireSegments([wire]) }));
	return selected.map((wire) => {
		const nets = new Set(parents.filter(p => missingWireSegments([{ ...wire, net: '' }], p.segments).length === 0).map(p => p.net));
		if (nets.size !== 1)
			throw new Error(`无法唯一确定选中导线的网络归属（${wire.line.flat().join(', ')}），请重新选择`);
		return { ...wire, net: [...nets][0] };
	});
}

function segments(wires: Array<SelectionWire>): Array<Segment> {
	const result: Array<Segment> = [];
	for (const wire of wires) {
		if (!Array.isArray(wire.line))
			continue;
		const paths = Array.isArray(wire.line[0]) ? wire.line as Array<Array<number>> : [wire.line as Array<number>];
		for (const path of paths) {
			for (let i = 0; i + 3 < path.length; i += 2) {
				const [x1, y1, x2, y2] = path.slice(i, i + 4);
				if ([x1, y1, x2, y2].every(Number.isFinite) && Math.hypot(x2 - x1, y2 - y1) > EPS)
					result.push({ x1, y1, x2, y2, net: wire.net });
			}
		}
	}
	return result;
}

/** 比较线段覆盖而非走线数量：宿主合并/拆分走线后，几何和网络仍必须完整。 */
export function missingWireSegments(expected: Array<SelectionWire>, actual: Array<SelectionWire>): Array<Segment> {
	const candidates = segments(actual);
	return segments(expected).filter((segment) => {
		const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
		const ux = (segment.x2 - segment.x1) / length;
		const uy = (segment.y2 - segment.y1) / length;
		const intervals: Array<[number, number]> = [];
		for (const candidate of candidates) {
			if (segment.net && !isAutomaticNet(segment.net) && candidate.net !== segment.net)
				continue;
			const ax = candidate.x1 - segment.x1;
			const ay = candidate.y1 - segment.y1;
			const bx = candidate.x2 - segment.x1;
			const by = candidate.y2 - segment.y1;
			if (Math.abs(ax * uy - ay * ux) > EPS || Math.abs(bx * uy - by * ux) > EPS)
				continue;
			const a = ax * ux + ay * uy;
			const b = bx * ux + by * uy;
			intervals.push([Math.max(0, Math.min(a, b)), Math.min(length, Math.max(a, b))]);
		}
		intervals.sort((a, b) => a[0] - b[0]);
		let end = 0;
		for (const [start, stop] of intervals) {
			if (start > end + EPS)
				break;
			end = Math.max(end, stop);
		}
		return end < length - EPS;
	});
}

/** 自动网络编号由目标工程重新分配，不作为命名网络要求。 */
export function isAutomaticNet(net: string): boolean {
	return /^\$\d*N\d+$/.test(net);
}

export function pointOnWire(wire: SelectionWire, x: number, y: number): boolean {
	return segments([wire]).some((s) => {
		const dx = s.x2 - s.x1;
		const dy = s.y2 - s.y1;
		const length = Math.hypot(dx, dy);
		return Math.abs((x - s.x1) * dy - (y - s.y1) * dx) <= EPS * length
			&& x >= Math.min(s.x1, s.x2) - EPS && x <= Math.max(s.x1, s.x2) + EPS
			&& y >= Math.min(s.y1, s.y2) - EPS && y <= Math.max(s.y1, s.y2) + EPS;
	});
}
