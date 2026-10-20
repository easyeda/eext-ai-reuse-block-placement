const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const loaded = esbuild.build({
	entryPoints: ['src/schematic-vision.ts'],
	bundle: true,
	write: false,
	format: 'cjs',
	plugins: [{ name: 'host', setup(b) {
		b.onResolve({ filter: /^\.\/host$/ }, () => ({ path: 'host', namespace: 'test' }));
		b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const edaGlobal=()=>globalThis.eda;export const sleep=async()=>{};export const withTimeout=p=>p;' }));
	} }],
});

async function fixture(options = {}) {
	const events = [];
	let reads = 0;
	let imaged = false;
	const selected = [{ primitiveId: 'U6', componentType: 'part', designator: 'U6', x: 100, y: 100 }];
	if (options.selectedWire)
		selected.push({ primitiveId: 'segment', line: [100, 100, 200, 100], net: 'incorrect-sdk-net' });
	const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: imaged && options.switchPage ? 'another' : 'source', tabId: 'source@origin' }) },
		sch_SelectControl: { getAllSelectedPrimitives: async () => {
			reads++;
			return options.empty || (options.switchSelection && reads > 1) ? [] : selected;
		} },
		sch_PrimitiveComponent: { getAllPinsByPrimitiveId: async () => [{ x: 800, y: 100 }] },
		dmt_EditorControl: {
			zoomToAllPrimitives: async () => events.push('page'),
			zoomToRegion: async (...args) => {
				events.push(args);
				return true;
			},
			getCurrentRenderedAreaImage: async () => {
				imaged = true;
				return options.noImage ? undefined : options.large ? { type: 'image/png', size: 5 * 1024 * 1024, arrayBuffer: async () => bytes.buffer } : new Blob([bytes], { type: 'image/png' });
			},
		},
	};
	const m = { exports: {} };
	vm.runInNewContext((await loaded).outputFiles[0].text, { module: m, exports: m.exports, eda });
	return { api: m.exports, events, bytes };
}

test('captures native PNG with actual selected designators and pixel dimensions', async () => {
	const f = await fixture();
	const result = await f.api.captureSchematicView('viewport');
	assert.equal(result.image.dataUrl, `data:image/png;base64,${f.bytes.toString('base64')}`);
	assert.equal(result.observation.width, 1);
	assert.equal(result.observation.height, 1);
	assert.equal(result.observation.selection.components[0].id, 'U6');
	assert.equal(f.events.length, 0);
});

test('selection view includes pins and neighboring context with native upward Y coordinates', async () => {
	const f = await fixture();
	const result = await f.api.captureSchematicView('selection');
	const [left, right, top, bottom] = f.events[0];
	assert(left < 100 && right > 800);
	assert(top > 100 && bottom < 100);
	assert.equal(result.observation.selection.components.length, 1);
});

test('exposes actual selected wire segment ids and geometry for precise removal', async () => {
	const { api } = await fixture({ selectedWire: true });
	const { observation } = await api.captureSchematicView('viewport');
	assert.equal(observation.selection.wireCount, 1);
	assert.equal(observation.selection.wires[0].id, 'segment');
	assert.deepEqual(Array.from(observation.selection.wires[0].line), [100, 100, 200, 100]);
	assert.equal(observation.selection.wires[0].net, undefined);
});

test('does not silently capture an empty selection, invalid region or missing image', async () => {
	await assert.rejects((await fixture({ empty: true })).api.captureSchematicView('selection'), /选区为空/);
	await assert.rejects((await fixture()).api.captureSchematicView('region', { left: 3, right: 1, top: 0, bottom: 2 }), /有效/);
	await assert.rejects((await fixture({ noImage: true })).api.captureSchematicView('page'), /未返回/);
	await assert.rejects((await fixture({ large: true })).api.captureSchematicView('viewport'), /4 MiB/);
});

test('rejects snapshots when the user changes the page or selection while capturing', async () => {
	await assert.rejects((await fixture({ switchPage: true })).api.captureSchematicView('viewport'), /图页已切换/);
	await assert.rejects((await fixture({ switchSelection: true })).api.captureSchematicView('viewport'), /选区已变化/);
});

test('base64 conversion works without browser or Node encoding globals', async () => {
	const { api } = await fixture();
	for (const length of [0, 1, 2, 3, 17, 12000]) {
		const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
		assert.equal(api.imageBase64(bytes), Buffer.from(bytes).toString('base64'));
	}
});

test('reports stale background rendering instead of claiming an unchanged image shows a new region', async () => {
	const { api } = await fixture();
	await api.captureSchematicView('region', { left: 0, right: 100, top: 0, bottom: 100 });
	await api.captureSchematicView('region', { left: 0, right: 100, top: 0, bottom: 100 });
	await assert.rejects(api.captureSchematicView('region', { left: 100, right: 200, top: 0, bottom: 100 }), /图像未随缩放刷新/);
});
