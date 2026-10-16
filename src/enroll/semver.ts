// Ported verbatim from pinta-manager sidecar/src/enroll/version-detect.ts
// (only the comparison helpers — CLI probing stays in the manager).

/** Numeric-segment semver comparison, tolerant of missing segments. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function isAtLeast(version: string, target: string): boolean {
  return compareSemver(version, target) >= 0;
}
