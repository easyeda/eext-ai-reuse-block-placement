const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function runScenario(calls) {
	const loaded = await esbuild.build({
		stdin: { contents: 'export {chatTurn} from "./src/agent/loop";', resolveDir: process.cwd() },
		bundle: true,
		write: false,
		format: 'cjs',
		plugins: [{ name: 'runtime', setup(b) {
			b.onResolve({ filter: /(^|\/)host$/ }, () => ({ path: 'host', namespace: 'test' }));
			b.onResolve({ filter: /^\.\/http$/ }, () => ({ path: 'http', namespace: 'test' }));
			b.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'host'
				? 'export const edaGlobal=()=>globalThis.eda;export const sleep=async()=>{};export const withTimeout=p=>p;export const fmtErr=e=>e.message;'
				: 'export const classifyLlmError=e=>({kind:"other",message:e.message});export const registerAbort=()=>({signal:{aborted:false}});export const releaseAbort=()=>{};export const STREAM_SENTINEL="streamed";export const sendLlmRequest=req=>globalThis.modelResponse(req);' }));
		} }],
	});
	let selected = [];
	let frame = 0;
	let writes = 0;
	const chip = {
		primitiveId: 'chip',
		getState_PrimitiveId: () => 'chip',
		getState_ComponentType: () => 'part',
		getState_Designator: () => 'U1',
		getState_Component: () => ({ name: 'MCU' }),
		getState_X: () => 100,
		getState_Y: () => 100,
	};
	const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
	const eda = {
		lib_LibrariesList: { getPersonalLibraryUuid: async () => 'personal', getAllLibrariesList: async () => [] },
		lib_Cbb: { create: async () => {
			writes++;
			throw new Error('Must not write before clicking the card');
		} },
		sys_Storage: { getExtensionUserConfig: key => ({ llm_provider: 'openai-chat', llm_model: 'vision-test', llm_api_key: 'test', llm_base_url: 'https://example.test/v1' })[key] },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'source', tabId: 'source@origin' }) },
		sch_PrimitiveComponent: { getAll: async () => [chip], getAllPinsByPrimitiveId: async () => [{ x: 100, y: 100 }] },
		sch_PrimitiveWire: { getAll: async () => [] },
		sch_PrimitiveAttribute: { getAll: async () => [] },
		sch_SelectControl: {
			getAllSelectedPrimitives: async () => selected.includes('chip') ? [chip] : [],
			clearSelected: async () => selected = [],
			doSelectPrimitives: async ids => selected = Array.from(ids),
		},
		dmt_EditorControl: {
			zoomToAllPrimitives: async () => undefined,
			zoomToRegion: async () => true,
			getCurrentRenderedAreaImage: async () => new Blob([bytes, new Uint8Array([frame++])], { type: 'image/png' }),
		},
	};
	const requests = [];
	async function modelResponse(request) {
		const body = JSON.parse(request.body);
		requests.push(body);
		const index = requests.length - 1;
		if (index) {
			assert(body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')));
			const observations = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
			if (observations.at(-1).vision)
				assert.equal(observations.at(-1).vision.selection.components.length, selected.includes('chip') ? 1 : 0);
		}
		const call = calls[index];
		return { choices: [{ message: call
			? { content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
			: { content: '已根据选区图检查并修正，请核对。' } }] };
	}
	const m = { exports: {} };
	vm.runInNewContext(loaded.outputFiles[0].text, { module: m, exports: m.exports, eda, modelResponse });
	const result = await m.exports.chatTurn('vision-session', '检查当前原理图并把主控电路存为模块', 'test');
	return { result, requests, selected, writes };
}

test('agent sees images before selecting, sees actual selection, then sees its correction', async () => {
	const { result, requests, selected } = await runScenario([
		['read_schematic', {}],
		['select_module', { seed: 'U1' }],
		['select_primitives', { mode: 'remove', ids: ['chip'] }],
	]);
	assert.equal(result.error, undefined);
	assert.equal(requests.length, 4);
	assert.equal(result.tools.length, 3);
	assert(result.tools.every(t => t.status === 'ok' && t.images?.length === 1));
	assert.equal(result.cards.length, 0);
	assert.deepEqual(selected, []);
});

test('either selection tool can show a creation card in the same turn without writing the library', async () => {
	for (const selection of [
		['select_module', { seed: 'U1' }],
		['select_primitives', { mode: 'replace', ids: ['chip'] }],
	]) {
		const { result, requests, selected, writes } = await runScenario([
			selection,
			['propose_create_module', { name: '主控模块' }],
		]);
		assert.equal(result.error, undefined);
		assert.equal(requests.length, 3);
		assert.equal(result.tools.length, 2);
		assert(result.tools.every(t => t.status === 'ok'));
		assert.equal(result.cards.length, 1);
		assert.equal(result.cards[0].type, 'create_module');
		assert.equal(result.cards[0].summary.parts, 1);
		assert.deepEqual(Array.from(result.cards[0].summary.designators), ['U1']);
		assert.deepEqual(selected, ['chip']);
		assert.equal(writes, 0);
	}
});
