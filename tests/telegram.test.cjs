const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const page of ['index', 'register', 'login', 'dashboard', 'deposit', 'withdraw', 'invest', 'profile', 'referral', 'contact', 'reset-password', 'terms']) {
  test(`${page} exposes the Telegram community link without JavaScript`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', `${page}.html`), 'utf8');
    assert.match(html, /href="assets\/telegram\.css"/);
    const links = html.match(/<a class="easypay-telegram"[^>]*>Join us on Telegram ↗<\/a>/g);
    assert.equal(links?.length, 1);
    assert.match(links[0], /href="https:\/\/t\.me\/easypayngn"/);
    assert.match(links[0], /target="_blank"/);
    assert.match(links[0], /rel="noopener noreferrer"/);
    assert.ok(html.indexOf(links[0]) > html.indexOf('<body>'));
  });
}
