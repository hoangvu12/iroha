export interface CredentialProblem {
  readonly field: 'username' | 'password'
  readonly message: string
}

export const USERNAME_MINIMUM = 3
export const USERNAME_MAXIMUM = 64
export const PASSWORD_MINIMUM = 12
/** Bounds the work one request can ask the password hasher to do. */
export const PASSWORD_MAXIMUM = 512

/** Ordinary account characters. Whitespace and control characters are excluded. */
const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]+$/

export type CredentialCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly CredentialProblem[] }

/**
 * Checks a username and password before either reaches storage or the hasher.
 *
 * Problems describe the rule that failed and never quote the submitted value,
 * so a validation message cannot echo a password back into a log or response.
 */
export function checkCredentials(input: {
  username: unknown
  password: unknown
}): CredentialCheck<{ username: string; password: string }> {
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  const problems = [...usernameProblems(username), ...passwordProblems(password)]

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: { username, password } }
}

/** The password rule alone, for recovery, which does not change the username. */
export function checkPassword(input: unknown): CredentialCheck<string> {
  const password = typeof input === 'string' ? input : ''
  const problems = passwordProblems(password)

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: password }
}

function usernameProblems(username: string): readonly CredentialProblem[] {
  if (username.length < USERNAME_MINIMUM || username.length > USERNAME_MAXIMUM) {
    return [
      {
        field: 'username',
        message: `must be between ${USERNAME_MINIMUM} and ${USERNAME_MAXIMUM} characters`,
      },
    ]
  }

  if (!USERNAME_PATTERN.test(username)) {
    return [
      {
        field: 'username',
        message: 'may contain only letters, digits, and the characters . _ - @ +',
      },
    ]
  }

  return []
}

function passwordProblems(password: string): readonly CredentialProblem[] {
  if (password.length < PASSWORD_MINIMUM) {
    return [{ field: 'password', message: `must be at least ${PASSWORD_MINIMUM} characters` }]
  }

  if (password.length > PASSWORD_MAXIMUM) {
    return [{ field: 'password', message: `must be at most ${PASSWORD_MAXIMUM} characters` }]
  }

  return []
}
