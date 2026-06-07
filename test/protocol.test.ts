import { describe, expect, it } from 'vitest'

import { ALLOWED_CHILD_ENV_KEYS } from '../src/protocol.js'

describe('protocol', () => {
  it('matches runner allowlisted env keys', () => {
    expect(ALLOWED_CHILD_ENV_KEYS).toEqual(['SESSION_ID', 'PROJECT_ID', 'BUILD_ID'])
  })
})
