import { describe, expect, test } from 'vitest';

import { settingsDraftFingerprint } from './settingsDraft';

describe('deferred settings comparison', () => {
  test('navigation and property order do not create a draft, while edits and undo compare correctly', () => {
    const original = { proxy: false, providers: { a: { models: ['first', 'second'], enabled: true } } };
    const baseline = settingsDraftFingerprint(original);
    expect(settingsDraftFingerprint({ providers: original.providers, proxy: false })).toBe(baseline);
    expect(settingsDraftFingerprint({ ...original, proxy: true })).not.toBe(baseline);
    expect(settingsDraftFingerprint({ ...original, proxy: false })).toBe(baseline);
    expect(settingsDraftFingerprint({ ...original, providers: { a: { models: ['second', 'first'], enabled: true } } })).not.toBe(baseline);
  });
});
