import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION } from "../../src/core/version.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function jsonVersion(...segments: string[]): string {
  const doc = JSON.parse(
    readFileSync(join(repoRoot, ...segments), "utf-8"),
  ) as { version: string };
  return doc.version;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.m?ts$/.test(full) ? [full] : [];
  });
}

/**
 * Blank out comments while preserving line numbers and string contents.
 *
 * Splitting on `//` would be wrong in both directions here. This repo records
 * measured host versions inside JSDoc blocks (`src/core/types.ts` documents
 * which codex release added each hook event, `src/core/otlp.ts` dumps a real
 * codex 0.154.0 hook environment), which a line-comment-only stripper leaves in
 * and reports as violations; and a `//` inside a string literal, such as a URL,
 * would truncate real code and hide a version sitting after it.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * These tests exist because this package drifted once already and because
 * `npm run bump` is a convention, not an enforcement.
 *
 * The first drift was here: package.json said 1.7.0 while `GUARD_UA`,
 * `PLUGIN_VERSION` and the plugin manifest all still said 1.6.0. The fix was
 * `tests/core/self-version.test.ts`, which pinned each of those three constants
 * to package.json by regex. That held — this repo has been in sync since — but
 * it pins the constants it knows about, so a fourth copy added later would have
 * said nothing.
 *
 * Two sibling adaptors then drifted the same way, without the test:
 *
 *   - pinta-copilot `chore(release): 0.7.0` (1574743) shipped sending
 *     `User-Agent: pinta-copilot/0.6.0`
 *   - pinta-opencode `chore(release): 0.8.0` (754e57d) shipped sending 0.7.0
 *
 * Both commits touched package.json and package-lock.json and nothing else,
 * which is what plain `npm version` produces. Release commits carry the same
 * title in every repo, so the log does not distinguish the ones that ran the
 * script from the ones that did not.
 *
 * These values are consumed by systems that *store* them — the manager
 * attributes guard calls per adaptor from the User-Agent, and `PLUGIN_VERSION`
 * is `telemetry.sdk.version` on every span — so a stale constant misattributes
 * real traffic to a release that never ran, and the stale-session warning built
 * on that attribution compares a fiction against reality.
 *
 * So this replaces pinning with removing: `src/` now holds one version literal,
 * and the last test bans any other. There is nothing left to keep in sync
 * inside `src/`, and a copy reintroduced anywhere in it fails the build.
 */
describe("adaptor version", () => {
  it("is a real semver in package.json", () => {
    expect(jsonVersion("package.json")).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    );
  });

  it("matches the version in package.json", () => {
    expect(ADAPTER_VERSION).toBe(jsonVersion("package.json"));
  });

  it("matches the version in the codex plugin manifest", () => {
    // The manifest is data, so it cannot import ADAPTER_VERSION the way `src/`
    // does. This assertion is the only thing holding the two together, and the
    // manifest is one of the three that drifted at 1.7.0.
    expect(ADAPTER_VERSION).toBe(jsonVersion(".codex-plugin", "plugin.json"));
  });

  it("is the only version literal in src/", () => {
    // Host versions this adaptor *measures* (codex 0.154.0, and the releases
    // that introduced each hook event) are documented in comments, which are
    // stripped above: they describe what was observed, not what we ship.
    const versionLiteral = /(?<![\w.-])\d+\.\d+\.\d+(?![\w.-])/;
    const versionFile = join(repoRoot, "src", "core", "version.ts");
    const offenders: string[] = [];

    for (const file of sourceFiles(join(repoRoot, "src"))) {
      if (file === versionFile) continue;
      const rel = file.slice(repoRoot.length);
      stripComments(readFileSync(file, "utf-8"))
        .split("\n")
        .forEach((line, i) => {
          if (versionLiteral.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }

    expect(
      offenders,
      "Version literals must be derived from ADAPTER_VERSION in src/core/version.ts, " +
        "not copied. Copies drift silently.",
    ).toEqual([]);
  });
});
