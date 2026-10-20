import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluationExample } from '../fixtures/evaluation.js';

const cli = new URL('../../src/evaluation/cli.js', import.meta.url);
test('offline CLI reads three explicit local files, emits only summary, and never echoes controlled text on errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bau-evaluation-'));
  try {
    const input = evaluationExample();
    const files = ['round', 'references', 'results'].map(name => join(directory, `${name}.json`));
    for (const [index, value] of [input.round, input.references, input.results].entries()) await writeFile(files[index]!, JSON.stringify(value));
    const summary = spawnSync(process.execPath, [cli.pathname, 'summary', ...files], { encoding: 'utf8' });
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).decision, 'cannot_determine');
    assert.ok(!summary.stdout.includes('CONTROLLED'));
    const inputs = spawnSync(process.execPath, [cli.pathname, 'inputs', files[0]!], { encoding: 'utf8' });
    assert.equal(inputs.status, 0, inputs.stderr);
    assert.ok(!inputs.stdout.includes('referenceId'));
    await writeFile(files[1]!, '{"CONTROLLED secret":');
    const malformed = spawnSync(process.execPath, [cli.pathname, 'summary', ...files], { encoding: 'utf8' });
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).decision, 'cannot_determine');
    assert.ok(!`${malformed.stdout}${malformed.stderr}`.includes('CONTROLLED'));
    assert.ok(!`${malformed.stdout}${malformed.stderr}`.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the committed 24-case example is executable and remains synthetic with unknown labor cost', () => {
  const files = ['round', 'references', 'results'].map(name => new URL(`../../../examples/evaluation/${name}.json`, import.meta.url).pathname);
  const result = spawnSync(process.execPath, [cli.pathname, 'summary', ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.scenes.map((scene: { useful: number; denominator: number }) => [scene.useful, scene.denominator]), [[9, 12], [9, 12]]);
  assert.equal(summary.decision, 'cannot_determine');
  assert.equal(summary.costs.human.manual.completeActualMicrousd, null);
  assert.equal(summary.costs.indexing.initial.knownActualMicrousd, 500);
});

test('bounded UTF-8 file refusal cannot mask an independently recorded actual failed control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bau-evaluation-'));
  try {
    const input = evaluationExample();
    input.results.gates[0]!.status = 'failed'; input.results.gates[0]!.basis = 'actual';
    const files = ['round', 'references', 'results'].map(name => join(directory, `${name}.json`));
    await writeFile(files[0]!, JSON.stringify(input.round));
    await writeFile(files[2]!, JSON.stringify(input.results));
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]) {
      await writeFile(files[1]!, bytes);
      const result = spawnSync(process.execPath, [cli.pathname, 'summary', ...files], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.deepEqual(JSON.parse(result.stdout).stopPaths, ['identity']);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(directory));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
