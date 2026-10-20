const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const loaded = esbuild.build({
	entryPoints: ['src/wire-labels.ts'],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node',
	plugins: [{
		name: 'host-test-runtime',
		setup(build) {
			build.onResolve({ filter: /^\.\/host$/ }, () => ({ path: 'host', namespace: 'test' }));
			build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
				export const edaGlobal = () => globalThis.eda;
				export const sleep = async () => {};
				export const withTimeout = p => p;
			` }));
		},
	}],
});

async function fixture(options = {}) {
	const expected = [{ net: 'VBUS', x: 5, y: 0 }];
	const attrs = [
		{ id: 'label', parent: 'wire', key: 'Name', value: 'VBUS', x: 5, y: 0, visible: true },
		{ id: 'empty-name', parent: 'wire', key: 'Name', value: '', x: 0, y: 0, visible: true },
		{ id: 'port', parent: 'component', key: 'Name', value: 'GND', x: 0, y: 0, visible: true },
		{ id: 'comment', parent: 'wire', key: 'Comment', value: 'keep me', x: 0, y: 0, visible: true },
	];
	if (options.missing)
		attrs[0].visible = false;
	if (options.wrongPosition)
		attrs[0].x = 8;
	if (options.rounding)
		attrs[0].x += 1e-13;
	if (options.extra)
		attrs.push({ ...attrs[0], id: 'duplicate' });
	if (options.legacy)
		attrs[0].key = 'NET';
	const primitive = a => ({
		getState_PrimitiveId: () => a.id,
		getState_ParentPrimitiveId: () => a.parent,
		getState_Key: () => a.key,
		getState_Value: () => a.value,
		getState_ValueVisible: () => a.visible,
		getState_KeyVisible: () => false,
		getState_X: () => a.x,
		getState_Y: () => a.y,
	});
	const eda = {
		sch_PrimitiveWire: { getAll: async () => [{ getState_PrimitiveId: () => 'wire' }] },
		sch_PrimitiveAttribute: {
			getAll: async () => {
				if (options.readError)
					throw new Error('read failed');
				return attrs.map(primitive);
			},
			modify: async () => { throw new Error('must not rely on hiding attributes'); },
		},
		sch_Document: { save: async () => !options.saveFailure },
	};
	const module = { exports: {} };
	vm.runInNewContext((await loaded).outputFiles[0].text, { module, exports: module.exports, eda });
	return { api: module.exports, run: () => module.exports.saveModuleWithWireNetLabels(expected) };
}

test('preserves original visible labels and ignores empty names, ports and custom attributes', async () => {
	await (await fixture()).run();
});

test('checks the raw NET alias and tolerates harmless coordinate rounding', async () => {
	await (await fixture({ legacy: true, rounding: true })).run();
});

test('rejects extra or duplicated labels after saving', async () => {
	await assert.rejects((await fixture({ extra: true })).run(), /原图没有/);
});

test('rejects missing or displaced original labels', async () => {
	await assert.rejects((await fixture({ missing: true })).run(), /缺少 1 个/);
	await assert.rejects((await fixture({ wrongPosition: true })).run(), /原图没有/);
});

test('save or read errors cannot be reported as successful module creation', async () => {
	await assert.rejects((await fixture({ saveFailure: true })).run(), /保存模块失败/);
	await assert.rejects((await fixture({ readError: true })).run(), /read failed/);
});

test('supports getter-only and legacy primitive state without treating blank text as a label', async () => {
	const { api } = await fixture();
	assert.equal(api.wireNetLabelState({ key: 'Name', value: 'VBUS', valueVisible: true }).visible, true);
	assert.equal(api.wireNetLabelState({ key: 'Name', value: '', valueVisible: true }).visible, false);
	assert.equal(api.wireNetLabelState({ key: 'Comment', value: 'x', valueVisible: true }).visible, false);
	assert.equal(api.wireNetLabelState({ key: 'NET', value: 'VBUS', valueVisible: true, getState_ValueVisible: () => false }).visible, false);
});
