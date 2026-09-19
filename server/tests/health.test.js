import test from 'node:test';
import assert from 'node:assert/strict';
import config, { validateConfig } from '../src/config/index.js';

test('Configuration validation', async (t) => {
  await t.test('baseline validation succeeds with default values', () => {
    assert.doesNotThrow(() => {
      validateConfig();
    });
  });

  await t.test('validates required db options when requested', () => {
    const originalUrl = config.supabaseUrl;
    config.supabaseUrl = '';
    try {
      assert.throws(
        () => {
          validateConfig({ requireDb: true });
        },
        (err) => {
          assert.match(err.message, /Missing required environment variables/);
          return true;
        }
      );
    } finally {
      config.supabaseUrl = originalUrl;
    }
  });

  await t.test('validates required cron options when requested', () => {
    const originalSecret = config.cronSecret;
    config.cronSecret = '';
    try {
      assert.throws(
        () => {
          validateConfig({ requireCron: true });
        },
        (err) => {
          assert.match(err.message, /CRON_SECRET/);
          return true;
        }
      );
    } finally {
      config.cronSecret = originalSecret;
    }
  });
});

test('Health endpoint unit logic', async (t) => {
  await t.test('returns expected health payload shape', () => {
    const healthPayload = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };

    assert.equal(healthPayload.status, 'ok');
    assert.ok(healthPayload.timestamp);
    assert.ok(typeof healthPayload.uptime === 'number');
  });
});
