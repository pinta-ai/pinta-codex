/**
 * The single source of truth for this adaptor's own version.
 *
 * There is exactly one version literal in `src/`, and it lives here. That is a
 * deliberate constraint, enforced by `tests/core/adapter-version.test.ts`,
 * which checks this value against package.json and `.codex-plugin/plugin.json`
 * and scans `src/` for any other literal of the same shape.
 *
 * The constraint exists because `npm run bump` -- which does update every
 * embedded copy in lock-step -- is a convention, and nothing enforces it. This
 * repo drifted that way once: package.json said 1.7.0 while GUARD_UA,
 * PLUGIN_VERSION and the plugin manifest all still said 1.6.0. The fix pinned
 * each of those three constants by regex, which held, but pinned only the
 * copies it knew about.
 *
 * Two sibling adaptors then drifted the same way without that test. Both
 * shipped a release whose commit touched package.json and package-lock.json and
 * nothing else, which is exactly what plain `npm version` produces:
 * pinta-copilot 0.7.0 (1574743) sent `User-Agent: pinta-copilot/0.6.0`, and
 * pinta-opencode 0.8.0 (754e57d) sent 0.7.0. The release commits are titled
 * `chore(release): <version>` in every repo, so reading the log does not tell
 * you which ones ran the script.
 *
 * These values are consumed by systems that *store* them -- the manager
 * attributes guard calls per adaptor from the User-Agent, and spans carry the
 * plugin version into the backend -- so a drift is invisible on the machine
 * that produced it and wrong everywhere the numbers are read. A comment saying
 * "keep in sync" sat directly above both of the old literals. A comment is not
 * a mechanism; a failing test is.
 *
 * It is a literal rather than an import of package.json because the bundle is
 * produced by esbuild CLI invocations with no config file, and importing JSON
 * would inline the entire manifest into `dist/`.
 */
export const ADAPTER_VERSION = "1.9.0";
