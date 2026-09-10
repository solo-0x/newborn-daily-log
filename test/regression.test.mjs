import assert from 'node:assert/strict';
import test from 'node:test';
import html from '../lib/newborn-html.js';
import { sanitizeSettings } from '../lib/newborn-api.js';
import { enhanceWithFeedReminder } from '../lib/feed-reminder.js';

test('完整功能版同时包含记录默认值和喂奶提醒', () => {
  const merged = enhanceWithFeedReminder(html);
  const required = [
    'id="feedReminder"',
    'id="settingFeedInterval"',
    'feedIntervalMinutes:120',
    'renderFeedReminder',
    'id="lastRecordHint"',
    'inheritLastRecord',
    'formulaReferenceMode',
    'loadLatestRecords',
    'applyTypeDefaults'
  ];
  for (const marker of required) assert.ok(merged.includes(marker), `缺少功能标记：${marker}`);
  assert.doesNotThrow(() => new Function(merged.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('旧设置可自动补齐默认提醒间隔', () => {
  const settings = sanitizeSettings({ appTitle: '小宝记录', quickAmounts: [60, 90] }, false);
  assert.equal(settings.feedIntervalMinutes, 120);
  assert.equal(settings.appTitle, '小宝记录');
  assert.deepEqual(settings.quickAmounts, [60, 90]);
});

test('管理设置接受规定提醒间隔并拒绝无效值', () => {
  const settings = sanitizeSettings({ appTitle: '小宝记录', quickAmounts: [60], feedIntervalMinutes: 90 }, true);
  assert.equal(settings.feedIntervalMinutes, 90);
  assert.throws(() => sanitizeSettings({ appTitle: '小宝记录', quickAmounts: [60], feedIntervalMinutes: 75 }, true), /喂奶提醒间隔不正确/);
});
