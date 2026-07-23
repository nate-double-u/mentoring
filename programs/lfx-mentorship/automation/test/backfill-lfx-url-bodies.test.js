'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planBackfill, applyBackfill } = require('../bin/backfill-lfx-url-bodies');
const { upsertLfxUrlBlock } = require('../lib/lfx-url');

const URL1 = 'https://mentorship.lfx.linuxfoundation.org/project/005db8db-7efe-4433-9605-91d14174c72c';
const URL2 = 'https://mentorship.lfx.linuxfoundation.org/project/0071e2ff-f538-4817-978b-07b267cfcd6a';
const ROOT = 'programs/lfx-mentorship';

function exportsWithPrograms() {
  return [
    {
      dir: `${ROOT}/2026/02-Jun-Aug`,
      data: {
        programs: [
          { issue_number: 101, program_name_full: 'CNCF - Project A: Old term', lfx_url: URL1 },
        ],
      },
    },
    {
      dir: `${ROOT}/2026/03-Sep-Nov`,
      data: {
        programs: [
          { issue_number: 201, program_name_full: 'CNCF - Project B: Current term', lfx_url: URL1 },
          { issue_number: 202, program_name_full: 'CNCF - Project C: Missing URL', lfx_url: '' },
          { issue_number: 203, program_name_full: 'CNCF - Project D: Bad issue', lfx_url: URL2 },
        ],
      },
    },
  ];
}

function fakeExec({ bodies }) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'view') return bodies[Number(args[2])] || '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { exec, calls };
}

test('planBackfill: selects recorded programs and filters by term', () => {
  const got = planBackfill(exportsWithPrograms(), { term: '2026/03-Sep-Nov' });
  assert.deepEqual(got.map((p) => p.issue_number), [201, 203]);
  assert.deepEqual(got.map((p) => p.dir), [`${ROOT}/2026/03-Sep-Nov`, `${ROOT}/2026/03-Sep-Nov`]);
});

test('applyBackfill: dry-run reads bodies but does not edit', async () => {
  const { exec, calls } = fakeExec({ bodies: { 201: 'proposal body' } });
  const lines = [];

  const summary = await applyBackfill([
    { issue_number: 201, title: 'CNCF - Project B', url: URL1 },
  ], {
    repo: 'cncf/mentoring',
    dryRun: true,
    exec,
    log: (line) => lines.push(line),
  });

  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 0);
  assert.deepEqual(calls, [
    ['issue', 'view', '201', '-R', 'cncf/mentoring', '--json', 'body', '-q', '.body'],
  ]);
  assert.ok(lines.includes('#201 would update'));
});

test('applyBackfill: apply writes a body file containing the LFX block', async () => {
  const { exec, calls } = fakeExec({ bodies: { 201: 'proposal body' } });
  const written = [];

  const summary = await applyBackfill([
    { issue_number: 201, title: 'CNCF - Project B', url: URL1 },
  ], {
    repo: 'cncf/mentoring',
    exec,
    log: () => {},
    writeBodyFile: (body) => {
      written.push(body);
      return 'scratch/body.md';
    },
    removeBodyFile: () => {},
  });

  assert.equal(summary.updated, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['issue', 'edit', '201', '-R', 'cncf/mentoring', '--body-file', 'scratch/body.md']);
  assert.ok(written[0].includes('<!-- lfx-url:start -->'));
  assert.ok(written[0].includes(`**LFX program:** [CNCF - Project B](${URL1})`));
});

test('applyBackfill: unchanged body is reported and not edited', async () => {
  const body = upsertLfxUrlBlock('proposal body', { title: 'CNCF - Project B', url: URL1 });
  const { exec, calls } = fakeExec({ bodies: { 201: body } });
  const lines = [];

  const summary = await applyBackfill([
    { issue_number: 201, title: 'CNCF - Project B', url: URL1 },
  ], {
    repo: 'cncf/mentoring',
    exec,
    log: (line) => lines.push(line),
  });

  assert.equal(summary.updated, 0);
  assert.equal(summary.unchanged, 1);
  assert.equal(calls.length, 1);
  assert.ok(lines.includes('#201 unchanged'));
});
