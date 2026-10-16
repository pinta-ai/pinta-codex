/**
 * Test double for the manager's token resolver (pinta-manager
 * `sidecar/src/enroll/relay.ts` `makeTokenResolver`), pinned to
 * sidecarPort 4318 / relayToken CODEX-TOKEN — the values the ported sidecar
 * tests were written against.
 */
export function testTokenResolver(source: string): string {
  switch (source) {
    case 'relay-endpoint':
      return 'http://127.0.0.1:4318/v1/traces';
    case 'relay-token':
      return 'x-pinta-relay-token=CODEX-TOKEN';
    case 'relay-token-raw':
      return 'CODEX-TOKEN';
    case 'relay-guard-endpoint':
      return 'http://127.0.0.1:4318/guard/evaluate';
    default:
      throw new Error(`unknown token source: ${source}`);
  }
}
