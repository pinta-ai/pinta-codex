const MESSAGE = `[pinta-codex] Authentication required: Pinta CLI identity not available.

To resolve:
  1. Install the Pinta CLI (see your team's setup instructions).
  2. Log in:
     pinta login
  3. (Optional) Check:
     pinta identity id

Once authenticated, retry your action.
`;

/** Returns the message with a trailing newline — suitable for stderr write or stdout body. */
export function authRequiredMessage(): string {
  return MESSAGE;
}
