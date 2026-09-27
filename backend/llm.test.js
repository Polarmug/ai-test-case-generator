const test = require('node:test');
const assert = require('node:assert');
const { normalize, parseJson } = require('./llm');

test('parseJson strips markdown fences and surrounding prose', () => {
  const text = 'Here you go:\n```json\n{"testCases": []}\n```\nHope this helps!';
  assert.deepStrictEqual(parseJson(text), { testCases: [] });
});

test('parseJson throws when there is no JSON', () => {
  assert.throws(() => parseJson('Sorry, I cannot help with that.'));
});

test('normalize fixes malformed test cases', () => {
  const { testCases } = normalize({
    testCases: [
      { testCaseId: 'TC-1', type: 'positive', steps: '1. Open page\n2. Click login', storyId: 7 },
      { type: 'Boundary', steps: null },
      'garbage',
      null
    ]
  });
  assert.strictEqual(testCases.length, 2);
  assert.strictEqual(testCases[0].type, 'Happy Path');
  assert.deepStrictEqual(testCases[0].steps, ['Open page', 'Click login']);
  assert.strictEqual(testCases[0].storyId, '7');
  assert.strictEqual(testCases[0].preconditions, '');
  assert.strictEqual(testCases[1].type, 'Edge Case');
  assert.strictEqual(testCases[1].testCaseId, 'TC-02');
  assert.deepStrictEqual(testCases[1].steps, []);
});

test('normalize handles missing testCases and coverage', () => {
  assert.deepStrictEqual(normalize({}), { testCases: [], coverage: [] });
  assert.deepStrictEqual(normalize(null), { testCases: [], coverage: [] });
});

test('normalize cleans coverage entries', () => {
  const { coverage } = normalize({
    coverage: [
      { criterion: 'valid login', testCaseIds: ['TC-1', ''] },
      { criterion: 'lockout' },
      { testCaseIds: ['TC-2'] }
    ]
  });
  assert.deepStrictEqual(coverage, [
    { criterion: 'valid login', testCaseIds: ['TC-1'] },
    { criterion: 'lockout', testCaseIds: [] }
  ]);
});

const { extractBobText } = require('./llm');

test('extractBobText reads last_message as a string', () => {
  const out = JSON.stringify({ type: 'result', status: 'success', last_message: '{"testCases": []}' });
  assert.strictEqual(extractBobText(out), '{"testCases": []}');
});

test('extractBobText reads last_message as a message object', () => {
  const out = JSON.stringify({ status: 'success', last_message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  assert.strictEqual(extractBobText(out), 'hi');
});

test('extractBobText rejects failed runs', () => {
  assert.throws(() => extractBobText(JSON.stringify({ status: 'error', last_message: 'x' })));
});
