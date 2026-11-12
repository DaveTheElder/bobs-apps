// tests/test_phases.js — project phases/tasks API: CRUD, validation, the
// progress rollup (taskless keeps manual %; with tasks it derives), explicit
// child cleanup on project delete (FK pragma is off; CASCADE is decoration).
process.env.PORT = process.env.TEST_PORT || '8093';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobs-phases-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DOCS_DIR = path.join(tmpDir, 'documents');
fs.mkdirSync(process.env.DOCS_DIR, { recursive: true });

const base = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const child = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(base + '/health'); up = r.ok; } catch {}
  }
  if (!up) { console.error('server did not start:\n' + log); process.exit(1); }

  const j = async (url, method = 'GET', body) => {
    const r = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };

  try {
    const proj = (await j('/api/projects', 'POST', { name: 'Phase test' })).data;
    assert(proj?.id, 'project created');

    await check('taskless project keeps manual progress via PUT', async () => {
      const r = await j(`/api/projects/${proj.id}`, 'PUT', { name: 'Phase test', progress: 42 });
      assert(r.data.progress === 42, `expected 42, got ${r.data.progress}`);
    });

    let ph1, ph2;
    await check('phase create, validate, order', async () => {
      ph1 = (await j(`/api/projects/${proj.id}/phases`, 'POST', { name: 'M0' })).data;
      ph2 = (await j(`/api/projects/${proj.id}/phases`, 'POST', { name: 'M1' })).data;
      assert(ph1.sort_order === 0 && ph2.sort_order === 1, 'sort_order increments');
      const bad = await j(`/api/projects/${proj.id}/phases`, 'POST', { name: '', });
      assert(bad.status === 400, 'empty name 400');
      const bad2 = await j(`/api/projects/${proj.id}/phases`, 'POST', { name: 'x', status: 'wat' });
      assert(bad2.status === 400, 'bogus status 400');
      const missing = await j('/api/projects/nope/phases', 'POST', { name: 'x' });
      assert(missing.status === 404, 'unknown project 404');
    });

    await check('phase move swaps order', async () => {
      const r = await j(`/api/phases/${ph2.id}/move`, 'POST', { dir: 'up' });
      assert(r.data.moved === true, 'moved');
      const list = (await j(`/api/projects/${proj.id}/phases`)).data;
      assert(list[0].name === 'M1' && list[1].name === 'M0', 'swapped');
      const edge = await j(`/api/phases/${list[0].id}/move`, 'POST', { dir: 'up' });
      assert(edge.data.moved === false, 'top move is a no-op');
    });

    let t1, t2;
    await check('tasks + derived progress rollup', async () => {
      t1 = (await j(`/api/phases/${ph1.id}/tasks`, 'POST', { title: 'codec' })).data;
      t2 = (await j(`/api/phases/${ph1.id}/tasks`, 'POST', { title: 'mesher' })).data;
      const t3 = (await j(`/api/phases/${ph2.id}/tasks`, 'POST', { title: 'server' })).data;
      let p = (await j(`/api/projects/${proj.id}`)).data;
      assert(p.progress === 0, `no tasks done yet, got ${p.progress}`);
      await j(`/api/tasks/${t1.id}`, 'PUT', { title: 'codec', status: 'done' });
      p = (await j(`/api/projects/${proj.id}`)).data;
      assert(p.progress === 33, `1/3 done → 33, got ${p.progress}`);
      await j(`/api/tasks/${t2.id}`, 'PUT', { title: 'mesher', status: 'done' });
      await j(`/api/tasks/${t3.id}`, 'PUT', { title: 'server', status: 'done' });
      p = (await j(`/api/projects/${proj.id}`)).data;
      assert(p.progress === 100, `3/3 → 100, got ${p.progress}`);
      const bad = await j(`/api/phases/${ph1.id}/tasks`, 'POST', { title: 'x', status: 'nope' });
      assert(bad.status === 400, 'bogus task status 400');
    });

    await check('task delete recomputes progress', async () => {
      await j(`/api/tasks/${t2.id}`, 'DELETE');
      const p = (await j(`/api/projects/${proj.id}`)).data;
      assert(p.progress === 100, `2 of 2 remaining done → 100, got ${p.progress}`);
      await j(`/api/tasks/${t1.id}`, 'PUT', { title: 'codec', status: 'todo' });
      const p2 = (await j(`/api/projects/${proj.id}`)).data;
      assert(p2.progress === 50, `1 of 2 done → 50, got ${p2.progress}`);
    });

    await check('board nests phases+tasks with per-phase counts', async () => {
      const board = (await j('/api/board')).data;
      const me = board.find(b => b.id === proj.id);
      assert(me.phases.length === 2, 'two phases on board');
      // state after prior tests: M0 has codec(todo); M1 has server(done)
      const m0 = me.phases.find(p => p.name === 'M0');
      const m1 = me.phases.find(p => p.name === 'M1');
      assert(m0.tasks.length === 1 && m0.task_count === 1 && m0.done_count === 0,
        `M0 counts: ${m0.task_count}/${m0.done_count}`);
      assert(m1.done_count === 1, `M1 done: ${m1.done_count}`);
      assert(me.progress === 50, `board rollup 50, got ${me.progress}`);
    });

    await check('phase delete takes its tasks and re-rolls progress', async () => {
      await j(`/api/phases/${ph1.id}`, 'DELETE');
      const board = (await j('/api/board')).data;
      const me = board.find(b => b.id === proj.id);
      assert(me.phases.length === 1, 'one phase left');
      assert(me.phases[0].tasks.length === 1, 'M1 task survived');
    });

    await check('project notes + links persist; omitted fields do not blank them', async () => {
      const created = (await j('/api/projects', 'POST', {
        name: 'Notes test', notes: 'blocked on auth', links: 'repo|http://example.com/x',
      })).data;
      assert(created.notes === 'blocked on auth', 'notes on create');
      assert(created.links === 'repo|http://example.com/x', 'links on create');
      // PUT without notes/links keys (the phases quick-edit path) keeps prose
      const kept = (await j(`/api/projects/${created.id}`, 'PUT', { name: 'Notes test' })).data;
      assert(kept.notes === 'blocked on auth', `notes survived PUT, got '${kept.notes}'`);
      assert(kept.links === 'repo|http://example.com/x', 'links survived PUT');
      const edited = (await j(`/api/projects/${created.id}`, 'PUT',
        { name: 'Notes test', notes: 'unblocked', links: '' })).data;
      assert(edited.notes === 'unblocked' && edited.links === '', 'explicit update works');
      await j(`/api/projects/${created.id}`, 'DELETE');
    });

    await check('task notes round-trip through PUT', async () => {
      const t = (await j(`/api/phases/${ph2.id}/tasks`, 'POST', { title: 'noted task', notes: 'why' })).data;
      assert(t.notes === 'why', 'notes on create');
      const u = (await j(`/api/tasks/${t.id}`, 'PUT', { title: 'noted task', status: 'doing', notes: 'still why' })).data;
      assert(u.notes === 'still why', 'notes update');
      await j(`/api/tasks/${t.id}`, 'DELETE');
    });

    await check('stats: empty deadline never counts as overdue (regression)', async () => {
      const s0 = (await j('/api/stats')).data;
      assert(s0.overdue === 0, `no deadlines → overdue 0, got ${s0.overdue}`);
      await j(`/api/projects/${proj.id}`, 'PUT', { name: 'Phase test', deadline: '2020-01-01' });
      const s1 = (await j('/api/stats')).data;
      assert(s1.overdue === 1, `past deadline → overdue 1, got ${s1.overdue}`);
    });

    await check('project delete leaves no orphan children', async () => {
      const { DatabaseSync } = require('node:sqlite');
      await j(`/api/projects/${proj.id}`, 'DELETE');
      const raw = new DatabaseSync(process.env.DB_PATH);
      const orphans = raw.prepare(
        'SELECT COUNT(*) AS n FROM project_tasks WHERE phase_id IN (SELECT id FROM project_phases WHERE project_id = ?)'
      ).get(proj.id).n;
      const phases = raw.prepare('SELECT COUNT(*) AS n FROM project_phases WHERE project_id = ?').get(proj.id).n;
      raw.close();
      assert(orphans === 0 && phases === 0, `orphans=${orphans} phases=${phases}`);
    });
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
