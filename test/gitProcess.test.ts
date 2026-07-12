import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GitAbortError,
  GitOutputLimitError,
  NullFieldParser,
  runGitNull,
  runGitText
} from '../src/gitProcess';

test('incrementally parses NUL fields across UTF-8 chunk boundaries', () => {
  const parser = new NullFieldParser(10);
  const encoded = Buffer.from('one\0two spaces\0snowman ☃\0', 'utf8');
  assert.equal(parser.push(encoded.subarray(0, 5)), true);
  assert.equal(parser.push(encoded.subarray(5, encoded.length - 2)), true);
  assert.equal(parser.push(encoded.subarray(encoded.length - 2)), true);
  assert.deepEqual(parser.finish(), ['one', 'two spaces', 'snowman ☃']);
});

test('bounds retained NUL fields and omits an incomplete tail', () => {
  const parser = new NullFieldParser(2);
  assert.equal(parser.push(Buffer.from('one\0two\0three\0')), false);
  assert.deepEqual(parser.finish(false), ['one', 'two']);
});

test('runs Git text commands and enforces output limits', async () => {
  assert.match(await runGitText('.', ['--version']), /^git version /);
  await assert.rejects(
    runGitText('.', ['--version'], { maxOutputBytes: 2 }),
    GitOutputLimitError
  );
});

test('returns bounded complete NUL fields with an explicit truncation flag', async () => {
  const result = await runGitNull('.', ['ls-files', '-z'], {
    maxFields: 1
  });
  assert.equal(result.fields.length, 1);
  assert.equal(result.truncated, true);
});

test('rejects an already aborted Git command', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runGitText('.', ['--version'], { signal: controller.signal }),
    GitAbortError
  );
});
