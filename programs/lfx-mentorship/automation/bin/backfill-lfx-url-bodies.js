#!/usr/bin/env node
'use strict';

// One-time throwaway migration for proposal issue bodies.
//
// This is NOT part of the ongoing automation. Run it locally once to backfill
// older proposal issues whose LFX URLs were recorded before /lfx-url started
// pinning the link into the issue body.
//
//   node bin/backfill-lfx-url-bodies.js --repo <owner/repo> [--term <year/termdir>] [--dry-run]
//
// The script self-locates the repo root, so it works from the repo root, the
// automation dir, or a worktree root.
//
// The tested block formatting and export scanning logic live in lib/lfx-url.js.
// This file is thin gh I/O glue: fetch the current issue body, compute the
// idempotent replacement, and write it back only when it changes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readExports, recordedPrograms, upsertLfxUrlBlock } = require('../lib/lfx-url');

const EXPORT_ROOT = 'programs/lfx-mentorship';
const USAGE = 'Usage: node bin/backfill-lfx-url-bodies.js --repo <owner/repo> [--term <year/termdir>] [--dry-run] (self-locates repo root)';

let tmpCounter = 0;

function parseArgs(argv) {
  const opts = { repo: '', term: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i] || '';
    else if (a === '--term') opts.term = argv[++i] || '';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return opts;
}

function ghExec(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.join(' ')}\n${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function planBackfill(exports, { term = '' } = {}) {
  const wantedDir = term ? `${EXPORT_ROOT}/${term}` : '';
  return (exports || [])
    .filter((entry) => !wantedDir || entry.dir === wantedDir)
    .flatMap((entry) => recordedPrograms(entry.data).map((program) => ({
      dir: entry.dir,
      issue_number: program.issue_number,
      title: program.program_name_full || '',
      url: program.lfx_url.trim(),
    })));
}

function writeBodyTempFile(body) {
  const dir = os.tmpdir();
  const file = path.join(dir, `lfx-url-backfill-body-${process.pid}-${Date.now()}-${tmpCounter++}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
}

async function applyBackfill(programs, {
  repo,
  dryRun = false,
  exec = ghExec,
  log = console.log,
  writeBodyFile = writeBodyTempFile,
  removeBodyFile = removeFile,
} = {}) {
  const summary = { total: 0, updated: 0, unchanged: 0 };

  for (const program of programs) {
    summary.total += 1;
    const issue = String(program.issue_number);
    const body = await exec(['issue', 'view', issue, '-R', repo, '--json', 'body', '-q', '.body']);
    const nextBody = upsertLfxUrlBlock(body, { title: program.title, url: program.url });

    if (nextBody === body) {
      summary.unchanged += 1;
      log(`#${issue} unchanged`);
      continue;
    }

    if (dryRun) {
      summary.updated += 1;
      log(`#${issue} would update`);
      continue;
    }

    const bodyFile = writeBodyFile(nextBody);
    try {
      await exec(['issue', 'edit', issue, '-R', repo, '--body-file', bodyFile]);
    } finally {
      removeBodyFile(bodyFile);
    }
    summary.updated += 1;
    log(`#${issue} updated`);
  }

  const changedLabel = dryRun ? 'would update' : 'updated';
  log(`Summary: ${summary.total} processed, ${summary.updated} ${changedLabel}, ${summary.unchanged} unchanged`);
  return summary;
}

async function main(argv, { exec = ghExec } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.repo) {
    console.log(USAGE);
    return 1;
  }

  // Cwd-proof the relative export root, matching the e2e harness convention.
  // Works from the repo root, the automation dir, or a worktree root.
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  process.chdir(repoRoot);

  const exports = readExports(fs, EXPORT_ROOT);
  const programs = planBackfill(exports, { term: opts.term });
  await applyBackfill(programs, { repo: opts.repo, dryRun: opts.dryRun, exec });
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, ghExec, planBackfill, applyBackfill, main };
