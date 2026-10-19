const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync('register.html', 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import.*;$/gm, '');

function setup({ profileFails = false, verificationFails = false } = {}) {
  const elements = new Map();
  const calls = [];
  const user = { uid: 'test-user' };
  const values = {
    username: 'tester', fullname: 'Test User', email: 'test@example.com',
    password: ' secret123 ', 'confirm-password': ' secret123 ', referral: ''
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: values[id] || '', checked: true, disabled: false,
      classList: { add() {}, remove() {} },
      addEventListener(event, handler) { this[event] = handler; }
    });
    return elements.get(id);
  }
  const context = {
    document: { getElementById: element },
    window: { location: { search: '' } }, URLSearchParams,
    console: { error() {} }, setTimeout() {},
    initializeApp() {}, getAuth() { return {}; }, getFirestore() {},
    doc(...args) { return args; }, serverTimestamp() { return 'timestamp'; },
    async createUserWithEmailAndPassword(auth, email, password) {
      calls.push(['create', email, password]); return { user };
    },
    async setDoc(path, data) {
      calls.push(['profile', data]);
      if (profileFails) throw { code: 'permission-denied' };
    },
    async deleteUser(value) { assert.equal(value, user); calls.push(['delete']); },
    async sendEmailVerification(value) {
      assert.equal(value, user); calls.push(['verify']);
      if (verificationFails) { verificationFails = false; throw { code: 'auth/network-request-failed' }; }
    }
  };
  vm.runInNewContext(source, context);
  return { element, calls, click: () => element('registerBtn').click() };
}

test('creates a rules-compatible profile before sending modular verification', async () => {
  const app = setup();
  await app.click();
  assert.deepEqual(app.calls.map(c => c[0]), ['create', 'profile', 'verify']);
  const profile = app.calls[1][1];
  assert.equal(profile.balance, 10);
  for (const key of ['role', 'suspended', 'referralCredited']) assert.equal(key in profile, false);
  assert.equal(app.calls[0][2], ' secret123 ');
  assert.match(app.element('toast').textContent, /Registration successful/);
});

test('rolls back Auth account if profile creation fails', async () => {
  const app = setup({ profileFails: true });
  await app.click();
  assert.deepEqual(app.calls.map(c => c[0]), ['create', 'profile', 'delete']);
  assert.equal(app.element('registerBtn').disabled, false);
  assert.match(app.element('toast').textContent, /setup was denied/);
});

test('retries verification without recreating account or overwriting bonus', async () => {
  const app = setup({ verificationFails: true });
  await app.click();
  assert.equal(app.element('registerBtn').textContent, 'Retry verification email');
  await app.click();
  assert.deepEqual(app.calls.map(c => c[0]), ['create', 'profile', 'verify', 'verify']);
});

test('rejects mismatched passwords and missing terms without creating account', async () => {
  const app = setup();
  app.element('confirm-password').value = 'secret123';
  await app.click();
  assert.equal(app.calls.length, 0);
  app.element('confirm-password').value = app.element('password').value;
  app.element('agreeTerms').checked = false;
  await app.click();
  assert.equal(app.calls.length, 0);
});

test('ignores repeated clicks while signup is pending', async () => {
  const app = setup();
  await Promise.all([app.click(), app.click()]);
  assert.equal(app.calls.filter(c => c[0] === 'create').length, 1);
});
