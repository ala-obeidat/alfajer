import crypto from 'node:crypto';

export function generateTurnCredentials(username: string, secret: string): { username: string, credential: string, ttl: number } {
  // 1-hour TTL
  const ttl = 3600;
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const turnUsername = `${timestamp}:${username}`;

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(turnUsername);
  const credential = hmac.digest('base64');

  return {
    username: turnUsername,
    credential,
    ttl
  };
}
