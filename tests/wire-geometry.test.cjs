const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({ entryPoints: ['src/wire-geometry.ts'], bundle: true, write: false, format: 'cjs' });
const moduleUnderTest = { exports: {} };
vm.runInNewContext(output.outputFiles[0].text, { module: moduleUnderTest, exports: moduleUnderTest.exports });
const { logicalWireSegments, missingWireSegments, resolveSelectedWireNets } = moduleUnderTest.exports;
const wire = (line, net = 'VBUS') => ({ line, net, color: null, lineWidth: null, lineType: null });

test('accepts merged or split, reversed segments with the original network', () => {
	assert.equal(missingWireSegments([wire([0, 0, 10, 0])], [wire([10, 0, 5, 0, 0, 0])]).length, 0);
	assert.equal(missingWireSegments([wire([0, 0, 5, 0]), wire([5, 0, 10, 0])], [wire([0, 0, 10, 0])]).length, 0);
});

test('detects a missing branch even if the number of logical wires is unchanged', () => {
	const expected = [wire([0, 0, 10, 0]), wire([5, 0, 5, 10])];
	const actual = [wire([0, 0, 10, 0]), wire([0, 0, 10, 0])];
	const missing = missingWireSegments(expected, actual);
	assert.equal(missing.length, 1);
	assert.equal(missing[0].y2, 10);
});

test('detects an interior gap and a wire assigned to the wrong network', () => {
	assert.equal(missingWireSegments([wire([0, 0, 10, 0])], [wire([0, 0, 4, 0]), wire([6, 0, 10, 0])]).length, 1);
	assert.equal(missingWireSegments([wire([0, 0, 10, 0])], [wire([0, 0, 10, 0], 'GND')]).length, 1);
});

test('nested paths do not create artificial bridges between disconnected sections', () => {
	assert.equal(missingWireSegments([wire([1, 0, 9, 0])], [wire([[0, 0, 1, 0], [9, 0, 10, 0]])]).length, 1);
});

test('ignores zero-length source segments and tolerates coordinate rounding', () => {
	assert.equal(missingWireSegments([wire([0, 0, 0, 0])], []).length, 0);
	assert.equal(missingWireSegments([wire([0, 0, 10, 0])], [wire([0, 1e-13, 10, 1e-13])]).length, 0);
});

test('unnamed source wires may acquire a host-generated name', () => {
	assert.equal(missingWireSegments([wire([0, 0, 10, 0], '')], [wire([0, 0, 10, 0], '$1N1')]).length, 0);
	assert.equal(missingWireSegments([wire([0, 0, 10, 0], '$1N123')], [wire([0, 0, 10, 0], '$2N99')]).length, 0);
});

test('logical wire state uses independent segment pairs without inventing bridges', () => {
	const actual = logicalWireSegments([wire([0, 0, 0, 5, 70, 10, 60, 10])]);
	assert.equal(actual.length, 2);
	assert.equal(missingWireSegments([wire([0, 5, 70, 10])], actual).length, 1);
	assert.equal(missingWireSegments([wire([60, 10, 70, 10])], actual).length, 0);
});

test('corrects the real O_+ segment reported as PVCC by the selection API', () => {
	const selected = [wire([675, 300, 655, 300], 'PVCC')];
	const logical = [
		wire([675, 300, 655, 300], 'O_+'),
		wire([725, 300, 725, 295, 795, 300, 785, 300, 725, 305, 725, 300], 'PVCC'),
	];
	const result = resolveSelectedWireNets(selected, logical);
	assert.equal(result[0].net, 'O_+');
	assert.equal(selected[0].net, 'PVCC');
});

test('matches partial selected segments and rejects unmatched or ambiguous source networks', () => {
	const selected = [wire([3, 0, 7, 0], 'wrong')];
	assert.equal(resolveSelectedWireNets(selected, [wire([0, 0, 10, 0], 'right')])[0].net, 'right');
	assert.throws(() => resolveSelectedWireNets(selected, []), /无法唯一确定/);
	assert.throws(() => resolveSelectedWireNets(selected, [wire([0, 0, 10, 0], 'A'), wire([0, 0, 10, 0], 'B')]), /无法唯一确定/);
});
