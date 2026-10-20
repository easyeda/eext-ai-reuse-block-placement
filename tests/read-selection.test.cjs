const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const loaded = esbuild.build({
	stdin: { contents: 'export {readSelectionSnapshot,selectModuleBySeed} from "./src/cbb";', resolveDir: process.cwd() },
	bundle: true,
	write: false,
	format: 'cjs',
	plugins: [{
		name: 'host-test-runtime',
		setup(build) {
			build.onResolve({ filter: /(^|\/)host$/ }, () => ({ path: 'host', namespace: 'test' }));
			build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const edaGlobal=()=>globalThis.eda;export const withTimeout=p=>p;export const sleep=async()=>{};export const fmtErr=e=>e.message;' }));
		},
	}],
});

test('snapshots the logical O_+ name and its visible label despite incorrect selected segment net', async () => {
	const primitive = (id, line, net) => ({
		primitiveId: id,
		getState_PrimitiveId: () => id,
		getState_Line: () => line,
		getState_Net: () => net,
	});
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'source' }) },
		sch_SelectControl: { getAllSelectedPrimitives: async () => [
			primitive('selected', [675, 300, 655, 300], 'PVCC'),
			primitive('rounding-noise', [1015, 510.0000000000002, 1015, 510], 'GND'),
			{ primitiveId: 'short', getState_ComponentType: () => 'short_symbol', getState_X: () => 685, getState_Y: () => 300, getState_Rotation: () => 90, getState_Mirror: () => true },
		] },
		sch_PrimitiveWire: { getAll: async () => [primitive('parent', [675, 300, 655, 300], 'O_+')] },
		sch_PrimitiveAttribute: { getAll: async () => [{ parentPrimitiveId: 'parent', primitiveId: 'label', key: 'Name', value: 'O_+', valueVisible: true, keyVisible: false, x: 655, y: 300 }] },
	};
	const module = { exports: {} };
	vm.runInNewContext((await loaded).outputFiles[0].text, { module, exports: module.exports, eda });
	const snapshot = await module.exports.readSelectionSnapshot();
	assert.equal(snapshot.wires.length, 1);
	assert.equal(snapshot.wires[0].net, 'O_+');
	assert.equal(snapshot.netLabels.length, 1);
	assert.equal(snapshot.netLabels[0].net, 'O_+');
	assert.match(snapshot.unsupported.join(','), /零长度走线×1/);
	assert.equal(snapshot.shortCircuitFlags.length, 1);
	assert.equal(snapshot.shortCircuitFlags[0].x, 685);
	assert.equal(snapshot.shortCircuitFlags[0].rotation, 90);
	assert.equal(snapshot.shortCircuitFlags[0].mirror, true);
	assert(!snapshot.unsupported.includes('short_symbol'));
});

test('automatic module selection includes short-circuit flags inside its region', async () => {
	const component = (id, type, x) => ({
		primitiveId: id,
		getState_ComponentType: () => type,
		getState_Designator: () => id === 'seed' ? 'U1' : '',
		getState_X: () => x,
		getState_Y: () => 0,
	});
	const components = [component('seed', 'part', 0), component('short', 'short_symbol', 10), component('outside', 'short_symbol', 100)];
	let selected = [];
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'source' }) },
		sch_PrimitiveComponent: { getAll: async () => components },
		sch_PrimitiveWire: { getAll: async () => [] },
		sch_SelectControl: {
			clearSelected: async () => selected = [],
			doSelectPrimitives: async ids => selected = ids,
			getAllSelectedPrimitives: async () => components.filter(c => selected.includes(c.primitiveId)),
		},
	};
	const module = { exports: {} };
	vm.runInNewContext((await loaded).outputFiles[0].text, { module, exports: module.exports, eda });
	const result = await module.exports.selectModuleBySeed('U1', { margin: 20 });
	assert.equal(result.shortCircuitFlagCount, 1);
	assert.deepEqual(Array.from(selected), ['seed', 'short']);
});
