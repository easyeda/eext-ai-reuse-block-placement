const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const result = esbuild.buildSync({ entryPoints: ['src/agent/llm.ts'], bundle: true, write: false, format: 'cjs' });
const m = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module: m, exports: m.exports });
const { buildAgentRequest, buildPingRequest, retainRecentImages } = m.exports;
const image = { dataUrl: 'data:image/png;base64,YWJj', caption: '选区图' };
const settings = provider => ({ provider, baseUrl: 'https://example.test/v1', model: 'vision-model', apiKey: 'test', visionEnabled: true });
function history() {
	return [
		{ role: 'user', content: '读取原理图' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_schematic', arguments: {} }, { id: 'b', name: 'view_schematic', arguments: {} }] },
		{ role: 'tool', toolCallId: 'a', content: '{"pageUuid":"source"}', images: [image] },
		{ role: 'tool', toolCallId: 'b', content: '{"selection":["U6"]}', images: [image] },
	];
}

test('Chat sends image_url blocks after every parallel tool result, preserving pairing', () => {
	const body = JSON.parse(buildAgentRequest(settings('openai-chat'), '', history(), '').body);
	assert.deepEqual(body.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
	assert.equal(body.messages[3].tool_call_id, 'a');
	assert.equal(body.messages[4].tool_call_id, 'b');
	const pictures = body.messages.at(-1).content.filter(c => c.type === 'image_url');
	assert.equal(pictures.length, 2);
	assert.equal(pictures[0].image_url.url, image.dataUrl);
	assert.equal(pictures[0].image_url.detail, 'high');
});

test('Responses sends native input_image separately from function_call_output JSON', () => {
	const body = JSON.parse(buildAgentRequest(settings('openai-responses'), '', history(), '').body);
	assert.equal(body.input.filter(i => i.type === 'function_call_output').length, 2);
	assert.equal(body.input.at(-1).role, 'user');
	assert.equal(body.input.at(-1).content.filter(c => c.type === 'input_image').length, 2);
	assert.equal(body.input.at(-1).content.find(c => c.type === 'input_image').image_url, image.dataUrl);
});

test('Anthropic keeps both tool_results and uses base64 image sources', () => {
	const body = JSON.parse(buildAgentRequest(settings('anthropic'), '', history(), '').body);
	const results = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result');
	assert.equal(results.length, 2);
	const picture = body.messages.at(-1).content.find(c => c.type === 'image');
	assert.deepEqual(picture.source, { type: 'base64', media_type: 'image/png', data: 'YWJj' });
});

test('disabling vision excludes even earlier history images for every provider', () => {
	for (const provider of ['openai-chat', 'openai-responses', 'anthropic']) {
		const request = buildAgentRequest({ ...settings(provider), visionEnabled: false }, '', history(), '');
		assert(!request.body.includes('YWJj'));
		assert(!request.body.includes('image_url'));
	}
});

test('image retention limits history without dropping any tool results', () => {
	const turns = Array.from({ length: 8 }, (_, i) => ({ role: 'tool', content: String(i), images: [image] }));
	retainRecentImages(turns);
	assert.equal(turns.length, 8);
	assert.equal(turns.reduce((sum, t) => sum + (t.images?.length || 0), 0), 3);
	assert.equal(turns[0].content, '0');
	assert.equal(turns.at(-1).images.length, 1);
});

test('rejects malformed image payloads instead of sending image-like text', () => {
	assert.throws(() => buildAgentRequest(settings('openai-chat'), '', [{ role: 'user', content: '', images: [{ ...image, dataUrl: 'https://untrusted.test/image' }] }], ''), /图像数据格式无效/);
});

test('connection testing validates image request acceptance when vision is enabled', () => {
	for (const provider of ['openai-chat', 'openai-responses', 'anthropic']) {
		assert(buildPingRequest(settings(provider)).body.includes('iVBOR'));
		assert(!buildPingRequest({ ...settings(provider), visionEnabled: false }).body.includes('iVBOR'));
	}
});
