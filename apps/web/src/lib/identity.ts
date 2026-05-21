export function getOrGenerateIdentity(nickname?: string): string {
  if (typeof window === 'undefined') return '';

  const existing = sessionStorage.getItem('alfajer_identity');
  if (existing) {
    return existing;
  }

  // Generate new identity
  const array = new Uint8Array(2);
  window.crypto.getRandomValues(array);
  const randomHex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  let safeNickname = 'gest'; // Default spelled gest as per spec
  if (nickname && nickname.trim() !== '') {
    // Sanitize nickname to alphanumeric
    safeNickname = nickname.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'gest';
  }

  const identity = `@${safeNickname}-${randomHex}`;
  sessionStorage.setItem('alfajer_identity', identity);
  
  return identity;
}

export function clearIdentity() {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem('alfajer_identity');
  }
}
