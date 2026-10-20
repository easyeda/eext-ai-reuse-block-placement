const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const loaded = esbuild.build({
	stdin: { contents: 'export {createCbbModuleFromSelection} from "./src/cbb";', resolveDir: process.cwd() },
	bundle: true,
	write: false,
	format: 'cjs',
	plugins: [{
		name: 'host-test-runtime',
		setup(build) {
			build.onResolve({ filter: /(^|\/)host$/ }, () => ({ path: 'host', namespace: 'test' }));
			build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
				export const edaGlobal = () => globalThis.eda;
				export const sleep = async () => {};
				export const withTimeout = p => p;
				export const fmtErr = e => e.message;
			` }));
		},
	}],
});

async function fixture(options = {}) {
	let project = 'origin';
	let page = 'origin-page';
	const wires = [];
	const flags = [];
	const shorts = [];
	const labels = [];
	const events = [];
	const primitiveWire = w => ({
		getState_PrimitiveId: () => w.id,
		getState_Line: () => w.line,
		getState_Net: () => w.net || '',
	});
	const flagPrimitive = f => ({
		getState_ComponentType: () => 'netflag',
		getState_Name: () => f.net,
		getState_X: () => f.x,
		getState_Y: () => f.y,
	});
	const shortPrimitive = (f) => {
		let rotation = f.rotation;
		let mirror = f.mirror;
		return {
			getState_PrimitiveId: () => f.id,
			getState_ComponentType: () => 'short_symbol',
			getState_X: () => f.x,
			getState_Y: () => f.y,
			getState_Rotation: () => f.rotation,
			getState_Mirror: () => f.mirror,
			setState_Rotation: r => rotation = r,
			setState_Mirror: m => mirror = m,
			done: async () => {
				await Promise.resolve();
				f.rotation = rotation;
				f.mirror = mirror;
				events.push('short-done');
			},
		};
	};
	const eda = {
		dmt_Project: {
			getCurrentProjectInfo: async () => ({ uuid: project }),
			openProject: async (uuid) => {
				project = uuid;
				return true;
			},
		},
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: page }) },
		dmt_Schematic: { getAllSchematicPagesInfo: async () => [{ uuid: 'new-page', name: 'P1' }] },
		dmt_EditorControl: { openDocument: async (uuid) => {
			page = uuid;
			return 'tab';
		} },
		lib_Cbb: {
			create: async () => {
				events.push('create');
				return 'new';
			},
			openProjectInEditor: async () => {
				project = 'new';
				page = '';
				return true;
			},
			delete: async () => {
				events.push('rollback');
				return true;
			},
		},
		sch_Document: { save: async () => {
			if (project !== 'origin' && options.dropShortAtSave)
				shorts.length = 0;
			return project === 'origin' || !options.failSave;
		} },
		sch_PrimitiveWire: {
			create: async (line, net) => {
				assert.equal(net, undefined, 'new wires must not generate explicit network labels');
				assert.equal(flags.length, 0, 'wires must be created before named primitives');
				events.push('wire');
				if (!options.dropWire)
					wires.push({ id: `wire-${wires.length}`, line, net: options.wrongNet ? 'GND' : '' });
				return undefined;
			},
			getAll: async () => wires.map(primitiveWire),
			getAllPrimitiveId: async () => wires.map(w => w.id),
		},
		sch_PrimitiveComponent: {
			getAll: async () => [...flags.map(flagPrimitive), ...shorts.map(shortPrimitive)],
			createShortCircuitFlag: async (x, y, rotation, mirror) => {
				events.push('short');
				if (!options.dropShort)
					shorts.push({ id: `short-${shorts.length}`, x, y, rotation: options.reverseShortRotation ? (360 - rotation) % 360 : rotation, mirror });
				return undefined;
			},
			createNetFlag: async (_kind, net, x, y) => {
				events.push('flag');
				flags.push({ net, x, y });
			},
		},
		sch_PrimitiveAttribute: {
			createNetLabel: async (x, y, net) => {
				events.push('label');
				labels.push({ x, y, net });
				wires[0].net = net;
				return undefined;
			},
			getAll: async () => labels.map((label, index) => ({
				getState_PrimitiveId: () => `label-${index}`,
				getState_ParentPrimitiveId: () => wires[0].id,
				getState_Key: () => 'Name',
				getState_Value: () => label.net,
				getState_ValueVisible: () => true,
				getState_KeyVisible: () => false,
				getState_X: () => label.x,
				getState_Y: () => label.y,
			})),
		},
	};
	const module = { exports: {} };
	vm.runInNewContext((await loaded).outputFiles[0].text, { module, exports: module.exports, eda });
	const snapshot = {
		parts: [],
		wires: [{ line: [0, 0, 10, 0], net: 'VBUS', color: null, lineWidth: null, lineType: null }],
		netFlags: options.visibleLabel ? [] : [{ componentName: 'Power-VBUS', net: 'VBUS', x: 0, y: 0, rotation: 0, mirror: false }],
		netPorts: [],
		shortCircuitFlags: options.shortFlag ? [{ x: 10, y: 0, rotation: 90, mirror: true }] : [],
		netLabels: options.visibleLabel ? [{ net: 'VBUS', x: 5, y: 0 }] : [],
		unsupported: [],
		primitiveIds: ['source-wire'],
	};
	return {
		run: () => module.exports.createCbbModuleFromSelection({ libraryUuid: 'personal', name: 'test', description: '', snapshot }),
		snapshot,
		events,
		get project() { return project; },
		get page() { return page; },
	};
}

test('creates unnamed wires before flags and preserves flag-defined names without new labels', async () => {
	const f = await fixture();
	const result = await f.run();
	assert.deepEqual(f.events, ['create', 'wire', 'flag']);
	assert.equal(result.rebuilt.wires, 1);
	assert.equal(result.failures.length, 0);
	assert.equal(f.project, 'origin');
	assert.equal(f.page, 'origin-page');
});

test('recreates only original visible labels even when create returns no primitive', async () => {
	const f = await fixture({ visibleLabel: true });
	await f.run();
	assert.deepEqual(f.events, ['create', 'wire', 'label']);
});

test('rolls back a silently dropped wire and restores the origin page', async () => {
	const f = await fixture({ dropWire: true });
	await assert.rejects(f.run(), /导线重建不完整/);
	assert.ok(f.events.includes('rollback'));
	assert.equal(f.project, 'origin');
	assert.equal(f.page, 'origin-page');
});

test('rolls back a failed module save', async () => {
	const f = await fixture({ failSave: true });
	await assert.rejects(f.run(), /保存模块失败/);
	assert.ok(f.events.includes('rollback'));
});

test('still rejects a genuine wrong network and reports it separately from missing geometry', async () => {
	const f = await fixture({ wrongNet: true });
	await assert.rejects(f.run(), /导线网络不一致.*VBUS：0,0 → 10,0/);
	assert.ok(f.events.includes('rollback'));
});

test('requires a naming source for named nets before creating a library entry', async () => {
	const f = await fixture();
	f.snapshot.netFlags = [];
	await assert.rejects(f.run(), /避免丢失网络名称/);
	assert.deepEqual(f.events, []);
});

test('recreates selected short-circuit flags and awaits correction of SDK rotation', async () => {
	const f = await fixture({ shortFlag: true, reverseShortRotation: true });
	const result = await f.run();
	assert.equal(result.rebuilt.shortCircuitFlags, 1);
	assert.deepEqual(f.events, ['create', 'wire', 'flag', 'short', 'short-done']);
});

test('rolls back when a short-circuit flag silently fails to create or disappears on save', async () => {
	for (const options of [{ dropShort: true }, { dropShortAtSave: true }]) {
		const f = await fixture({ shortFlag: true, ...options });
		await assert.rejects(f.run(), /短接标识/);
		assert.ok(f.events.includes('rollback'));
	}
});
