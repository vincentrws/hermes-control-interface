#!/usr/bin/env node
/**
 * Export kanban tasks to rich Obsidian markdown notes.
 *
 * Unlike the original ad-hoc export, each note includes the full event
 * timeline, comments, dependencies (as [[wikilinks]]), the **worker log**, and
 * **attachments** — real artifact files are copied into the vault and embedded;
 * for older tasks whose scratch workspace was already deleted, the deliverable
 * is best-effort recovered from the worker log's `cat <<EOF > file` blocks.
 *
 * Reads the kanban SQLite DB + worker logs + (preserved) workspace dirs directly
 * — no auth, no server needed. Run inside the Hermes container:
 *
 *   docker exec hermes node \
 *     /opt/vince/workspace/repos/hermes-control-interface/scripts/export_kanban_obsidian.js --all
 *
 * Usage: export_kanban_obsidian.js [<taskId> | --all] [--board main]
 * Env overrides: HERMES_HOME (default /opt/data), VAULT_DIR
 *   (default /opt/vince/workspace/vault).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const HERMES_HOME = process.env.HERMES_HOME || '/opt/data';
const VAULT_DIR = process.env.VAULT_DIR || '/opt/vince/workspace/vault';
const TASKS_DIR = path.join(VAULT_DIR, 'Tasks');
const ATTACH_ROOT = path.join(TASKS_DIR, 'attachments');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let board = 'main';
let target = null;
let all = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') all = true;
  else if (a === '--board') board = argv[++i] || 'main';
  else if (!a.startsWith('--')) target = a;
}
if (!all && !target) {
  console.error('Usage: export_kanban_obsidian.js [<taskId> | --all] [--board main]');
  process.exit(2);
}

// ── db ───────────────────────────────────────────────────────────────────────
function openDB() {
  const safe = (board || 'main').replace(/[^a-zA-Z0-9_-]/g, '');
  let p = path.join(HERMES_HOME, 'kanban', 'boards', safe, 'kanban.db');
  if (!fs.existsSync(p)) p = path.join(HERMES_HOME, 'kanban.db');
  if (!fs.existsSync(p)) { console.error(`kanban.db not found (looked under ${HERMES_HOME})`); process.exit(1); }
  return new Database(p, { readonly: true });
}
const db = openDB();
const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };

// ── helpers ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ts) {
  if (ts == null) return '';
  let ms = Number(ts);
  if (!isFinite(ms)) return '';
  if (ms < 1e12) ms *= 1000; // seconds → ms
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const dateOnly = (ts) => (fmtDate(ts) || '').split(' ')[0];
function parseJSON(v) { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } }
function fence(content, lang = '') {
  // Pick a fence longer than any backtick-run inside, so embedded ``` is safe.
  let max = 2;
  for (const m of String(content).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  const f = '`'.repeat(max + 1);
  return `${f}${lang}\n${content}\n${f}`;
}

// Recover `cat <<['"]?DELIM'? > /path` ... DELIM blocks from a worker log →
// map basename → content. Lets us reconstruct deliverables whose files were
// deleted before workspaces were preserved.
function recoverHeredocs(logText) {
  const out = new Map();
  if (!logText) return out;
  const lines = logText.split('\n');
  const re = /cat\s+<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*>\s*(\S+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const delim = m[2];
    const targetPath = m[3].replace(/['"]/g, '');
    // Rendered worker-log transcripts append timing to the closing line
    // (e.g. "EOF  0.1s"), so match the delimiter at line-start + a boundary
    // rather than requiring a bare line.
    const closeRe = new RegExp('^' + delim + '(?:\\s|$)');
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (closeRe.test(lines[j].trim())) break;
      body.push(lines[j]);
    }
    if (j < lines.length) { // closed properly
      out.set(path.basename(targetPath), body.join('\n'));
      i = j;
    }
  }
  return out;
}

function workspaceDirFor(taskId) {
  const safe = (board || 'main').replace(/[^a-zA-Z0-9_-]/g, '');
  const cands = [
    path.join(HERMES_HOME, 'kanban', 'boards', safe, 'workspaces', taskId),
    path.join(HERMES_HOME, 'kanban', 'workspaces', taskId),
    path.join(HERMES_HOME, 'workspaces', taskId),
  ];
  return cands.find((d) => fs.existsSync(d)) || null;
}

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

// ── per-task export ──────────────────────────────────────────────────────────
function exportTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) { console.warn(`  skip ${taskId}: not found`); return null; }

  const runs = q('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC', taskId);
  const events = q('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC', taskId);
  const comments = q('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC', taskId);
  const links = q('SELECT * FROM task_links WHERE parent_id = ? OR child_id = ?', taskId, taskId);
  const dbAttach = hasTable('task_attachments')
    ? q('SELECT * FROM task_attachments WHERE task_id = ?', taskId) : [];

  const parents = links.filter((l) => l.child_id === taskId).map((l) => l.parent_id);
  const children = links.filter((l) => l.parent_id === taskId).map((l) => l.child_id);

  // worker log
  const logPath = path.join(HERMES_HOME, 'kanban', 'logs', `${taskId}.log`);
  let workerLog = null;
  try { if (fs.existsSync(logPath)) workerLog = fs.readFileSync(logPath, 'utf8'); } catch {}
  const recovered = recoverHeredocs(workerLog);

  // resolve artifacts: db attachments ∪ run-metadata ∪ completed-event payloads
  const recordedPaths = new Set();
  for (const r of runs) {
    const m = parseJSON(r.metadata);
    if (m && Array.isArray(m.artifacts)) m.artifacts.forEach((a) => a && recordedPaths.add(String(a)));
  }
  for (const e of events) {
    if (e.kind !== 'completed' && e.kind !== 'done') continue;
    const p = parseJSON(e.payload);
    if (p && Array.isArray(p.artifacts)) p.artifacts.forEach((a) => a && recordedPaths.add(String(a)));
  }
  const wsDir = workspaceDirFor(taskId);

  // Build attachment descriptors
  const attachments = [];
  const seen = new Set();
  const addFromPath = (absPath, origin) => {
    const filename = path.basename(absPath);
    if (seen.has(filename)) return;
    seen.add(filename);
    let exists = false; try { exists = fs.statSync(absPath).isFile(); } catch {}
    attachments.push({ filename, absPath, exists, origin, recovered: !exists && recovered.has(filename) });
  };
  for (const a of dbAttach) addFromPath(a.stored_path || a.filename, 'db');
  for (const p of recordedPaths) addFromPath(p, 'recorded');
  if (wsDir) {
    for (const f of fs.readdirSync(wsDir)) {
      if (f.startsWith('.')) continue;
      const fp = path.join(wsDir, f);
      try { if (fs.statSync(fp).isFile()) addFromPath(fp, 'workspace'); } catch {}
    }
  }

  // Copy/recover files into the vault and build the Attachments section
  const vaultAttachDir = path.join(ATTACH_ROOT, taskId);
  const attachLines = [];
  let copiedAny = false;
  for (const a of attachments) {
    let vaultRel = null; // path relative to TASKS_DIR for embeds
    if (a.exists) {
      try {
        fs.mkdirSync(vaultAttachDir, { recursive: true });
        fs.copyFileSync(a.absPath, path.join(vaultAttachDir, a.filename));
        vaultRel = `attachments/${taskId}/${a.filename}`;
        copiedAny = true;
      } catch (e) { /* fall through to note */ }
    } else if (a.recovered) {
      try {
        fs.mkdirSync(vaultAttachDir, { recursive: true });
        fs.writeFileSync(path.join(vaultAttachDir, a.filename), recovered.get(a.filename));
        vaultRel = `attachments/${taskId}/${a.filename}`;
        copiedAny = true;
      } catch (e) { /* fall through */ }
    }
    const ext = path.extname(a.filename).toLowerCase();
    if (vaultRel) {
      const tag = a.recovered ? ' _(recovered from worker log)_' : '';
      if (ext === '.md' || IMG_EXT.has(ext)) {
        attachLines.push(`- 📄 **${a.filename}**${tag}\n\n  ![[Tasks/${vaultRel}]]`);
      } else {
        attachLines.push(`- 📄 [[Tasks/${vaultRel}|${a.filename}]]${tag}`);
      }
    } else {
      attachLines.push(`- 📄 ${a.filename} — _recorded, file no longer on disk_ (\`${a.absPath}\`)`);
    }
  }

  // ── compose markdown ───────────────────────────────────────────────────────
  const fmTags = ['kanban', 'task', task.status || 'unknown'];
  const fm = [
    '---',
    `tags: [${fmTags.join(', ')}]`,
    `id: ${taskId}`,
    `status: ${task.status || ''}`,
    `assignee: ${task.assignee || ''}`,
    `created_by: ${task.created_by || ''}`,
    `priority: ${task.priority != null ? task.priority : ''}`,
    `created: ${dateOnly(task.created_at)}`,
    '---',
  ];

  const out = [fm.join('\n'), '', `# ${task.title || taskId}`, ''];

  if (task.body) out.push('## Description', '', task.body.trim(), '');

  if (parents.length || children.length) {
    out.push('## Dependencies', '');
    if (parents.length) out.push(`**Parents:** ${parents.map((id) => `[[Task_${id}]]`).join(', ')}`, '');
    if (children.length) out.push(`**Children:** ${children.map((id) => `[[Task_${id}]]`).join(', ')}`, '');
  }

  if (runs.length) {
    out.push('## Run History', '');
    for (const r of runs) {
      out.push(`- Run \`${r.id}\` (${r.status}) by ${r.profile || task.assignee || '—'} at ${fmtDate(r.started_at)}`);
      if (r.summary) out.push(`  - **Summary**: ${r.summary}`);
      if (r.outcome) out.push(`  - **Outcome**: ${r.outcome}`);
      if (r.error) out.push(`  - **Error**: ${r.error}`);
      const m = parseJSON(r.metadata);
      if (m && m.worker_session_id) out.push(`  - **Session**: \`${m.worker_session_id}\``);
    }
    out.push('');
  }

  if (events.length) {
    out.push('## Events', '');
    for (const e of events) {
      const p = parseJSON(e.payload);
      let detail = '';
      if (p) {
        if (e.kind === 'completed' || e.kind === 'done') {
          const bits = [];
          if (p.summary) bits.push(p.summary);
          if (Array.isArray(p.artifacts) && p.artifacts.length) bits.push(`${p.artifacts.length} artifact(s)`);
          detail = bits.join(' · ');
        } else if (e.kind === 'spawned' && p.pid) detail = `pid ${p.pid}`;
        else if (e.kind === 'claimed' && p.lock) detail = `lock ${p.lock}`;
        else if (e.kind === 'created' && p.by) detail = `by ${p.by}`;
        else if (p.message) detail = p.message;
      }
      out.push(`- \`${e.kind}\` — ${fmtDate(e.created_at)}${detail ? ` — ${detail}` : ''}`);
    }
    out.push('');
  }

  if (comments.length) {
    out.push('## Comments', '');
    for (const c of comments) out.push(`- **${c.author || '—'}** (${fmtDate(c.created_at)}): ${c.body || ''}`);
    out.push('');
  }

  out.push(`## Attachments (${attachments.length})`, '');
  out.push(attachLines.length ? attachLines.join('\n') : '_— no attachments —_', '');

  if (workerLog) {
    const MAX = 60000;
    const shown = workerLog.length > MAX
      ? `…[truncated; full log ${workerLog.length} bytes at ${logPath}]…\n` + workerLog.slice(-MAX)
      : workerLog;
    out.push('## Worker Log', '', fence(shown, 'text'), '');
  }

  const md = out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, `Task_${taskId}.md`), md);
  return { taskId, title: task.title || taskId, status: task.status || 'unknown',
    created: dateOnly(task.created_at), attachments: attachments.length, copiedAny, workerLog: !!workerLog };
}

// ── MOC regeneration ─────────────────────────────────────────────────────────
function writeMOC(results) {
  const byStatus = {};
  for (const r of results) (byStatus[r.status] = byStatus[r.status] || []).push(r);
  const order = ['done', 'review', 'running', 'in_progress', 'ready', 'todo', 'blocked', 'triage', 'archived'];
  const statuses = Object.keys(byStatus).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const lines = ['# Kanban Tasks MOC', '', 'Status and central index of all tracked tasks.', ''];
  for (const s of statuses) {
    lines.push(`## ${s.toUpperCase()}`);
    for (const r of byStatus[s]) {
      const title = String(r.title).replace(/\s+/g, ' ').trim();
      lines.push(`- [[Task_${r.taskId}]] - ${title} (${r.created})`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(TASKS_DIR, '..', 'Kanban_MOC.md'), lines.join('\n') + '\n');
}

// ── run ──────────────────────────────────────────────────────────────────────
const ids = all ? db.prepare('SELECT id FROM tasks').all().map((r) => r.id) : [target];
const results = [];
for (const id of ids) {
  const r = exportTask(id);
  if (r) {
    results.push(r);
    console.log(`  ✓ Task_${id}.md  [${r.status}]  attachments=${r.attachments}${r.copiedAny ? ' (files copied)' : ''}${r.workerLog ? ' +log' : ''}`);
  }
}
if (all) { writeMOC(results); console.log(`  ✓ Kanban_MOC.md (${results.length} tasks)`); }
console.log(`Done. Exported ${results.length} task(s) to ${TASKS_DIR}`);
db.close();
