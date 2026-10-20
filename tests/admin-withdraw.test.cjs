const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const adminSource = readFileSync('admin-withdraw.html', 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import\b.*;$/gm, '');

const withdrawSource = readFileSync('withdraw.html', 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import\b.*;$/gm, '');

function flushMicrotasks(turns = 12) {
  let chain = Promise.resolve();
  for (let i = 0; i < turns; i++) {
    chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  }
  return chain;
}

function createAdminHarness({
  withdrawals = [],
  users = {},
  sessionSeed = {},
  deferUserBatch = false,
  collectionGroupErrorOnce = null,
  failUpdate = false
} = {}) {
  const calls = [];
  const elements = new Map();
  let authCallback = null;
  let pendingBatchResolvers = [];

  const storageData = new Map(Object.entries(sessionSeed));
  const sessionStorage = {
    getItem(k) { return storageData.has(k) ? storageData.get(k) : null; },
    setItem(k, v) { storageData.set(k, String(v)); }
  };

  const pendingCells = [];
  const tbodyEl = {
    _html: '<tr><td colspan="7" class="state-cell">Loading...</td></tr>',
    get innerHTML() { return this._html; },
    set innerHTML(val) {
      this._html = val;
      pendingCells.length = 0;
      const re = /<td data-plan-pending="([^"]*)">([^<]*)<\/td>/g;
      let match;
      while ((match = re.exec(val)) !== null) {
        pendingCells.push({
          uid: match[1],
          text: match[2],
          removed: false,
          getAttribute(name) { return name === 'data-plan-pending' ? this.uid : null; },
          removeAttribute(name) { if (name === 'data-plan-pending') this.removed = true; },
          set textContent(next) { this.text = next; },
          get textContent() { return this.text; }
        });
      }
    },
    querySelectorAll(selector) {
      if (selector === 'td[data-plan-pending]') return pendingCells.filter(c => !c.removed);
      return [];
    }
  };

  function getEl(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: id === 'statusFilter' ? 'all' : '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        style: { display: '' },
        classList: { add() {}, remove() {} },
        listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; },
        click() { if (this.listeners.click) return this.listeners.click(); }
      });
    }
    return elements.get(id);
  }

  const document = {
    body: { innerHTML: '' },
    getElementById: getEl,
    querySelector(sel) {
      if (sel === '#withdrawalTable tbody') return tbodyEl;
      return null;
    }
  };
  const window = { location: { href: 'admin-withdraw.html' } };

  const context = {
    document,
    window,
    sessionStorage,
    Date,
    console: { error() {} },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    initializeApp() { return {}; },
    getAuth() { return {}; },
    getFirestore() { return {}; },
    onAuthStateChanged(_auth, cb) { authCallback = cb; },
    collection(_db, ...segments) { return { kind: 'collection', path: segments.join('/') }; },
    collectionGroup(_db, name) { return { kind: 'collectionGroup', name }; },
    documentId() { return '__name__'; },
    where(field, op, val) { return { field, op, val }; },
    query(target, ...constraints) { return { kind: 'query', target, constraints }; },
    doc(_db, ...parts) { return { kind: 'doc', path: parts.join('/'), id: parts[parts.length - 1] }; },
    async getDoc(ref) {
      calls.push({ type: 'getDoc', path: ref.path });
      const data = users[ref.id];
      return {
        id: ref.id,
        exists: () => Boolean(data),
        data: () => data
      };
    },
    async getDocs(target) {
      if (target.kind === 'collectionGroup') {
        calls.push({ type: 'collectionGroup', name: target.name });
        if (collectionGroupErrorOnce) {
          const err = collectionGroupErrorOnce;
          collectionGroupErrorOnce = null;
          throw err;
        }
        return {
          forEach(fn) {
            for (const w of withdrawals) {
              fn({ ref: { path: w.path }, data: () => ({ ...w.data }) });
            }
          }
        };
      }
      if (target.kind === 'collection' && target.path === 'users') {
        calls.push({ type: 'usersCollection' });
        return {
          forEach(fn) {
            for (const [id, data] of Object.entries(users)) {
              fn({ id, data: () => ({ ...data }) });
            }
          }
        };
      }
      if (target.kind === 'collection' && target.path.endsWith('/withdrawals')) {
        calls.push({ type: 'userWithdrawals', path: target.path });
        const matching = withdrawals.filter(w => w.path.startsWith(target.path + '/'));
        return {
          forEach(fn) {
            for (const w of matching) {
              fn({ id: w.path.split('/').pop(), ref: { path: w.path }, data: () => ({ ...w.data }) });
            }
          }
        };
      }
      if (target.kind === 'query' && target.target.path === 'users') {
        const chunk = target.constraints[0].val;
        calls.push({ type: 'usersBatchIn', uids: [...chunk] });
        if (deferUserBatch) {
          await new Promise(resolve => pendingBatchResolvers.push(resolve));
        }
        const matched = chunk.filter(uid => Boolean(users[uid]));
        return {
          forEach(fn) {
            for (const uid of matched) {
              fn({ id: uid, data: () => ({ ...users[uid] }) });
            }
          }
        };
      }
      throw new Error('Unexpected getDocs target');
    },
    async updateDoc(ref, payload) {
      calls.push({ type: 'updateDoc', path: ref.path, payload });
      if (failUpdate) throw new Error('Write rejected');
    }
  };

  vm.runInNewContext(adminSource, context);

  return {
    calls,
    getEl,
    tbodyEl,
    pendingCells,
    document,
    window,
    storageData,
    updateStatus: context.window.updateStatus,
    releaseUserBatches() {
      const resolvers = pendingBatchResolvers.splice(0);
      resolvers.forEach(r => r());
    },
    async signIn(user) {
      await authCallback(user);
    }
  };
}

test('sorts pending withdrawals ahead of approved/rejected without ReferenceError and computes totals', async () => {
  const app = createAdminHarness({
    withdrawals: [
      { path: 'users/u1/withdrawals/w1', data: { amount: 2500, bank: 'Kuda', accNumber: '1111111111', accName: 'Ada', status: 'approved', timestamp: { seconds: 300 } } },
      { path: 'users/u2/withdrawals/w2', data: { amount: 1500, bank: 'Opay', accNumber: '2222222222', accName: 'Bola', status: 'pending', timestamp: { seconds: 100 } } },
      { path: 'users/u3/withdrawals/w3', data: { amount: 4000, bank: 'GTBank', accNumber: '3333333333', accName: 'Chidi', status: 'Successful', timestamp: { seconds: 200 } } },
      { path: 'users/u4/withdrawals/w4', data: { amount: 3000, bank: 'PalmPay', accNumber: '4444444444', accName: 'Dayo', status: 'Pending', timestamp: { seconds: 500 } } },
      { path: 'users/u5/withdrawals/w5', data: { amount: 1000, bank: 'UBA', accNumber: '5555555555', accName: 'Efe', status: 'Rejected', timestamp: { seconds: 400 } } }
    ],
    users: {
      u1: { activePlan: 'First' },
      u2: { plan: 'Starter' },
      u3: { activePlan: 'Basic' },
      u4: { plan: 'Mini' },
      u5: { plan: 'none' }
    }
  });

  await app.signIn({ uid: 'admin-1', email: 'anointedchidi7@gmail.com' });
  await flushMicrotasks();

  assert.equal(app.calls.some(c => c.type === 'getDoc'), false);
  assert.match(app.getEl('totalAmount').textContent, /6,500\.00/);
  assert.equal(app.getEl('summaryText').textContent, 'Pending: 2 | Approved: 2 | Rejected: 1');

  const namesInOrder = [...app.tbodyEl.innerHTML.matchAll(/<td>(Ada|Bola|Chidi|Dayo|Efe)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(namesInOrder, ['Dayo', 'Bola', 'Efe', 'Ada', 'Chidi']);
  assert.deepEqual(app.pendingCells.map(c => c.text), ['Mini', 'Starter', 'none', 'First', 'Basic']);
});

test('renders table rows immediately before background user plan queries complete', async () => {
  const app = createAdminHarness({
    deferUserBatch: true,
    withdrawals: [
      { path: 'users/u1/withdrawals/w1', data: { amount: 2000, bank: 'Opay', accNumber: '1234567890', accName: 'Instant User', status: 'pending', timestamp: { seconds: 200 } } },
      { path: 'users/u2/withdrawals/w2', data: { amount: 3000, bank: 'Kuda', accNumber: '0987654321', accName: 'Saved Plan User', plan: 'Second', status: 'approved', timestamp: { seconds: 150 } } }
    ],
    users: { u1: { activePlan: 'Third' } }
  });

  await app.signIn({ uid: 'admin-1', email: 'easypay27.ng@gmail.com' });
  await flushMicrotasks();

  assert.match(app.tbodyEl.innerHTML, /Instant User/);
  assert.match(app.tbodyEl.innerHTML, /<td>Second<\/td>/);
  assert.equal(app.pendingCells.length, 1);
  assert.equal(app.pendingCells[0].text, '...');

  app.releaseUserBatches();
  await flushMicrotasks();
  assert.equal(app.pendingCells[0].text, 'Third');
  assert.equal(app.pendingCells[0].removed, true);
});

test('automatically falls back to /users/{uid}/withdrawals when collectionGroup rules are not deployed yet', async () => {
  const app = createAdminHarness({
    collectionGroupErrorOnce: Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    users: {
      'signup-only': { balance: 10, plan: 'none' },
      'active-investor': { balance: 4000, activePlan: 'Starter', hasWithdrawals: true }
    },
    withdrawals: [
      { path: 'users/active-investor/withdrawals/w-live', data: { amount: 3500, bank: 'Opay', accNumber: '8125600222', accName: 'Chidi Investor', status: 'pending', timestamp: { seconds: 900 } } }
    ]
  });

  await app.signIn({ uid: 'admin-1', email: 'easypay27.ng@gmail.com' });
  await flushMicrotasks();

  // Prioritized active user first and rendered row + plan with 0 extra batch queries
  const subQueries = app.calls.filter(c => c.type === 'userWithdrawals');
  assert.equal(subQueries[0].path, 'users/active-investor/withdrawals');
  assert.equal(app.calls.some(c => c.type === 'usersBatchIn'), false);
  assert.match(app.tbodyEl.innerHTML, /Chidi Investor/);
  assert.match(app.tbodyEl.innerHTML, /<td>Starter<\/td>/);

  // Subsequent refresh skips collectionGroup completely because fallback flag is remembered
  app.getEl('refreshBtn').click();
  await flushMicrotasks();
  assert.equal(app.calls.filter(c => c.type === 'collectionGroup').length, 1);
});

test('paginates large withdrawal lists and only queries plans for visible page in <=10 UID batches', async () => {
  const withdrawals = [];
  const users = {};
  for (let i = 1; i <= 75; i++) {
    const uid = `user-${i}`;
    users[uid] = { activePlan: 'First' };
    withdrawals.push({
      path: `users/${uid}/withdrawals/w-${i}`,
      data: {
        amount: 1000,
        bank: 'Moniepoint',
        accNumber: String(1000000000 + i),
        accName: `Member ${i}`,
        status: 'approved',
        timestamp: { seconds: 1000 - i }
      }
    });
  }

  const app = createAdminHarness({ withdrawals, users });
  await app.signIn({ uid: 'admin-1', email: 'easypay27.ng@gmail.com' });
  await flushMicrotasks();

  const batchCalls = app.calls.filter(c => c.type === 'usersBatchIn');
  assert.equal(batchCalls.length, 5);
  assert.ok(batchCalls.every(c => c.uids.length <= 10));
  assert.equal(app.getEl('loadMoreWrap').style.display, 'block');
  assert.match(app.getEl('loadMoreBtn').textContent, /25 remaining/);

  app.getEl('loadMoreBtn').click();
  await flushMicrotasks();
  assert.equal(app.calls.filter(c => c.type === 'usersBatchIn').length, 8);
  assert.equal(app.getEl('loadMoreWrap').style.display, 'none');

  app.getEl('refreshBtn').click();
  await flushMicrotasks();
  assert.equal(app.calls.filter(c => c.type === 'usersBatchIn').length, 8);
});

test('handles auth edge cases, network errors, and status update rollback cleanly', async () => {
  const signedOut = createAdminHarness();
  await signedOut.signIn(null);
  assert.equal(signedOut.window.location.href, 'login.html');

  const unauth = createAdminHarness();
  await unauth.signIn({ uid: 'guest', email: 'guest@easypay.ng' });
  assert.match(unauth.document.body.innerHTML, /Not authorized/);

  const roleAdmin = createAdminHarness({
    collectionGroupErrorOnce: new Error('Network offline'),
    failUpdate: true,
    users: { 'role-admin': { role: 'admin' } },
    withdrawals: [
      { path: 'users/u1/withdrawals/w1', data: { amount: 5000, bank: 'GTBank', accNumber: '1111111111', accName: 'Test', plan: 'Mini', status: 'pending', timestamp: { seconds: 50 } } }
    ]
  });
  await roleAdmin.signIn({ uid: 'role-admin', email: 'custom@easypay.ng' });
  await flushMicrotasks();
  assert.match(roleAdmin.tbodyEl.innerHTML, /Failed to load withdrawals/);

  roleAdmin.getEl('refreshBtn').click();
  await flushMicrotasks();
  assert.match(roleAdmin.tbodyEl.innerHTML, /Test/);

  const selectMock = {
    value: 'approved',
    disabled: false,
    getAttribute(attr) { return attr === 'data-path' ? 'users/u1/withdrawals/w1' : null; }
  };
  await roleAdmin.updateStatus(selectMock);
  assert.equal(selectMock.value, 'pending');
  assert.equal(selectMock.disabled, false);
});

test('withdraw.html records user plan and withdrawal flag on newly created withdrawals', async () => {
  const addedDocs = [];
  const updatedDocs = [];
  const elements = new Map();
  let authCb = null;

  function el(id) {
    if (!elements.has(id)) {
      const defaults = { amount: '2000', bank: 'Opay', accName: 'Chidi Test', accNumber: '8125600222' };
      elements.set(id, {
        value: defaults[id] || '',
        disabled: false,
        textContent: '',
        innerHTML: '',
        className: '',
        addEventListener(ev, fn) { this[ev] = fn; }
      });
    }
    return elements.get(id);
  }

  const tbody = { innerHTML: '' };
  vm.runInNewContext(withdrawSource, {
    document: {
      getElementById: el,
      querySelector: () => tbody
    },
    window: { location: { href: 'withdraw.html' } },
    console: { error() {} },
    setTimeout() {},
    Date,
    initializeApp() { return {}; },
    getAuth() { return {}; },
    getFirestore() { return {}; },
    onAuthStateChanged(_a, cb) { authCb = cb; },
    doc(_db, ...parts) { return { path: parts.join('/') }; },
    collection(parent, name) { return { path: `${parent.path}/${name}` }; },
    query(ref) { return ref; },
    orderBy() { return {}; },
    limit() { return {}; },
    async getDoc() {
      return { exists: () => true, data: () => ({ balance: 5000, activePlan: 'Second' }) };
    },
    async updateDoc(_ref, payload) { updatedDocs.push(payload); },
    async addDoc(_col, payload) { addedDocs.push(payload); },
    async getDocs() { return { empty: true, forEach() {} }; }
  });

  await authCb({ uid: 'u-99' });
  await el('submitBtn').click();

  assert.equal(addedDocs.length, 1);
  assert.equal(addedDocs[0].plan, 'Second');
  assert.equal(addedDocs[0].status, 'pending');
  assert.equal(updatedDocs[0].hasWithdrawals, true);
});
