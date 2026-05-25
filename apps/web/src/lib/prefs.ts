// Lightweight localStorage helpers for cross-session user preferences.
// Wrapped so SSR and private-browsing modes don't throw.

function safeGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* private mode */ }
}
function safeRemove(key: string) {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch { /* ignore */ }
}

const NICKNAME = 'alfajer.pref.nickname';
const MIC_ID   = 'alfajer.pref.micId';
const CAM_ID   = 'alfajer.pref.cameraId';
const SPK_ID   = 'alfajer.pref.speakerId';
const AUDIO_ONLY = 'alfajer.pref.audioOnly';
const THEME    = 'alfajer.pref.theme';     // 'auto' | 'dark' | 'light'

export const prefs = {
  getNickname: () => safeGet(NICKNAME) ?? '',
  setNickname: (v: string) => v ? safeSet(NICKNAME, v) : safeRemove(NICKNAME),

  getMicId: () => safeGet(MIC_ID) ?? '',
  setMicId: (v: string) => v ? safeSet(MIC_ID, v) : safeRemove(MIC_ID),

  getCameraId: () => safeGet(CAM_ID) ?? '',
  setCameraId: (v: string) => v ? safeSet(CAM_ID, v) : safeRemove(CAM_ID),

  getSpeakerId: () => safeGet(SPK_ID) ?? '',
  setSpeakerId: (v: string) => v ? safeSet(SPK_ID, v) : safeRemove(SPK_ID),

  getAudioOnly: () => safeGet(AUDIO_ONLY) === '1',
  setAudioOnly: (v: boolean) => safeSet(AUDIO_ONLY, v ? '1' : '0'),

  getTheme: (): 'auto' | 'dark' | 'light' => {
    const v = safeGet(THEME);
    return v === 'light' || v === 'dark' ? v : 'auto';
  },
  setTheme: (v: 'auto' | 'dark' | 'light') => safeSet(THEME, v),
};
