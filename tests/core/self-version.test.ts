import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * This package hard-codes its own version in four places, and three of them had
 * drifted: package.json said 1.7.0 while GUARD_UA, PLUGIN_VERSION and the
 * plugin manifest all still said 1.6.0. `scripts/bump.mjs` exists to set them
 * in lock-step, but a script only helps when it is used, and nothing failed
 * when it wasn't.
 *
 * The drift is not cosmetic. The manager attributes a guard call to an adaptor
 * version by parsing the `pinta-<name>/<version>` User-Agent, and
 * PLUGIN_VERSION is the `telemetry.sdk.version` on every span — so a stale
 * constant misattributes real traffic to a release that never ran.
 */

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const declared = JSON.parse(read('package.json')).version as string;

const embedded: Array<{ where: string; find: () => string | undefined }> = [
  {
    where: "src/core/guard.ts GUARD_UA (the User-Agent the manager attributes guard calls by)",
    find: () => /const GUARD_UA = ['"]pinta-[a-z-]+\/([^'"]+)['"]/.exec(read('src/core/guard.ts'))?.[1],
  },
  {
    where: 'src/core/otlp.ts PLUGIN_VERSION (telemetry.sdk.version on every span)',
    find: () => /const (?:PLUGIN_VERSION|SDK_VERSION) = "([^"]+)"/.exec(read('src/core/otlp.ts'))?.[1],
  },
  {
    where: '.codex-plugin/plugin.json version (the plugin manifest)',
    find: () => JSON.parse(read('.codex-plugin/plugin.json')).version as string,
  },
];

describe('the version this package reports about itself', () => {
  it('is a real semver in package.json', () => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  for (const { where, find } of embedded) {
    it(`matches package.json in ${where}`, () => {
      const found = find();
      // A missing match means the constant was renamed or restyled, which also
      // breaks scripts/bump.mjs — it aborts rather than bumping partially.
      expect(found, `no version found in ${where}`).toBeDefined();
      expect(found, `run: npm run bump ${declared}`).toBe(declared);
    });
  }
});
