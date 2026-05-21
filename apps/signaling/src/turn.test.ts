import { describe, it, expect } from 'vitest';
import { generateTurnCredentials } from './turn';
import crypto from 'node:crypto';

describe('TURN Credentials', () => {
  it('should generate valid HMAC-SHA1 credentials', () => {
    const secret = 'supersecret';
    const username = 'testuser';
    const result = generateTurnCredentials(username, secret);

    expect(result.username).toMatch(/^\d+:testuser$/);
    expect(result.ttl).toBe(3600);

    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(result.username);
    const expectedCredential = hmac.digest('base64');

    expect(result.credential).toBe(expectedCredential);
  });
});
