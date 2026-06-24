import { test, expect, chromium } from '@playwright/test';

// Deep functional / regression pass for Alfajer.
//
// playwright.config.ts wires a webServer, so `bunx playwright test` boots the
// signaling (:3000) + web (:5173) servers itself — no manual setup. Chromium
// must be installed once (`bunx playwright install chromium`).
//
// Screenshots are written to each test's Playwright output dir via
// testInfo.outputPath(), so the spec is portable across machines / CI.

test.setTimeout(45000);

test.describe('Alfajer Deep Functional Test Pass', () => {

  test('Focus 2: Safari PWA install banner (spoofed UA) vs Chromium', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Chromium-only — launches its own fake-media browser');
    // 1. iPhone Safari spoofing — the manual "Add to Home Screen" banner path.
    const safariBrowser = await chromium.launch();
    const safariContext = await safariBrowser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const safariPage = await safariContext.newPage();

    // Safari exposes navigator.standalone; force the "not installed" value.
    await safariPage.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => false });
    });

    await safariPage.goto('/');

    const iosBanner = safariPage.locator('.install-banner.ios');
    await expect(iosBanner).toBeVisible();
    // The one-tap native "Install" button must NOT appear on Safari.
    await expect(safariPage.locator('button:has-text("Install")')).not.toBeVisible();
    await safariPage.screenshot({ path: testInfo.outputPath('1_safari_pwa_banner.png') });

    // Dismiss → banner hides and the 30-day localStorage key is recorded.
    await safariPage.click('button[aria-label="Dismiss install instructions"]');
    await expect(iosBanner).not.toBeVisible();
    const dismissedAt = await safariPage.evaluate(() => localStorage.getItem('alfajer.installDismissedAt'));
    expect(dismissedAt).not.toBeNull();
    expect(parseInt(dismissedAt!, 10)).toBeGreaterThan(0);

    // Reload → dismissal persists.
    await safariPage.reload();
    await expect(iosBanner).not.toBeVisible();
    await safariBrowser.close();

    // 2. Desktop Chrome — the manual banner must NOT render (native
    //    beforeinstallprompt path handles install there instead).
    const chromeBrowser = await chromium.launch();
    const chromeContext = await chromeBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const chromePage = await chromeContext.newPage();
    await chromePage.goto('/');
    await expect(chromePage.locator('.install-banner.ios')).not.toBeVisible();
    await chromeBrowser.close();
  });

  test('Focus 1 + general sweep: two-peer WebRTC call', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Chromium-only — launches its own fake-media browser');
    // One browser, two contexts = Host + Peer, with fake camera/mic.
    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const hostContext = await browser.newContext();
    const peerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    hostPage.on('console', msg => console.log(`[HOST]: ${msg.text()}`));
    hostPage.on('pageerror', err => console.log(`[HOST ERROR]: ${err}`));
    peerPage.on('console', msg => console.log(`[PEER]: ${msg.text()}`));
    peerPage.on('pageerror', err => console.log(`[PEER ERROR]: ${err}`));

    // Inject, before app code runs:
    //   * a second fake mic in enumerateDevices (to exercise switchMic),
    //   * a getUserMedia spy that records the EXACT constraints the app passes
    //     (rewriting only the mock deviceId so native Chromium doesn't throw),
    //   * an RTCPeerConnection spy whose getStats() can be forced to report
    //     framesPerSecond:0 (fake media never really drops frames).
    const injectSpysAndMockMic = async (p: typeof hostPage) => {
      await p.addInitScript(() => {
        const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = async () => {
          const list = await originalEnumerate();
          list.push({
            deviceId: 'mock-mic-2', kind: 'audioinput',
            label: 'Mock External Microphone (AEC)', groupId: 'mock-group',
            toJSON: () => ({}),
          } as any);
          return list;
        };

        const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        (window as any).capturedStreams = [];
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          let actual = constraints;
          const audio = constraints && (constraints.audio as any);
          if (audio && typeof audio === 'object' && audio.deviceId && audio.deviceId.exact === 'mock-mic-2') {
            actual = { ...constraints, audio: { ...audio, deviceId: { exact: 'default' } } };
          }
          const stream = await originalGUM(actual);
          (window as any).capturedStreams.push({ constraints, stream }); // original constraints
          return stream;
        };

        const OriginalPC = window.RTCPeerConnection;
        (window as any).peerConnections = [];
        // @ts-ignore
        window.RTCPeerConnection = function (config) {
          const pc = new OriginalPC(config);
          (window as any).peerConnections.push(pc);
          const originalGetStats = pc.getStats.bind(pc);
          pc.getStats = async function (selector) {
            const report = await originalGetStats(selector);
            if (!(window as any).mockRemoteVideoOff) return report;
            const mutated = new Map();
            report.forEach((stat: any, id: any) => {
              mutated.set(id, (stat.type === 'inbound-rtp' && stat.kind === 'video')
                ? { ...stat, framesPerSecond: 0 } : stat);
            });
            return mutated as any;
          };
          return pc;
        };
        window.RTCPeerConnection.prototype = OriginalPC.prototype;
      });
    };

    await injectSpysAndMockMic(hostPage);
    await injectSpysAndMockMic(peerPage);

    // 1. Host starts a room.
    await hostPage.goto('/');
    await hostPage.fill('input[placeholder="What should we call you?"]', 'Alice');
    await hostPage.click('button:has-text("Start new call")');
    await hostPage.waitForURL(/\/call\/\d+/);
    const roomId = hostPage.url().match(/\/call\/(\d+)/)?.[1];
    expect(roomId).toBeDefined();
    console.log(`[TEST] room ${roomId}`);
    await expect(hostPage.locator('.room-code')).toBeVisible();

    // 2. Peer knocks.
    await peerPage.goto(`/call/${roomId}`);
    await expect(peerPage.locator('input[placeholder="Your nickname"]')).toBeVisible();
    await peerPage.fill('input[placeholder="Your nickname"]', 'Bob');
    await peerPage.click('button:has-text("Ask to join")');

    // 3. Host accepts.
    const acceptBtn = hostPage.locator('button:has-text("Accept")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    // 4. Both sides connect.
    await expect(hostPage.locator('.security-pill')).toBeVisible({ timeout: 15000 });
    await hostPage.waitForSelector('.remote-video-wrapper video');
    await peerPage.waitForSelector('.remote-video-wrapper video');
    await hostPage.screenshot({ path: testInfo.outputPath('2_connected_call.png') });

    // 4b. Security state. The extra application-layer script-transform is
    //     currently DISABLED (E2EE_TRANSFORM_ENABLED=false): on real browsers
    //     it mangled media into pixelated/garbled video with no audio, so every
    //     call settles on DTLS-SRTP — which is still genuine end-to-end
    //     encryption that no signaling/TURN server can decrypt. Assert that
    //     honest state on both peers (and that it never claims the extra layer).
    await expect(hostPage.locator('.security-pill.dtls')).toBeVisible({ timeout: 10000 });
    await expect(peerPage.locator('.security-pill.dtls')).toBeVisible({ timeout: 10000 });
    await expect(hostPage.locator('.security-pill.e2ee')).toHaveCount(0);
    console.log('[TEST] both peers on DTLS-SRTP (extra layer disabled) ✓');

    // 5. Initial capture asserts AEC is on for both peers.
    // Assert on the REQUESTED constraints, not track.getSettings(): Chromium's
    // fake device reports echoCancellation/etc. true by default regardless of
    // what was asked, so getSettings() can't distinguish "app requested AEC"
    // from "device default". The captured constraints object is the real proof.
    const checkInitialAec = async (page: typeof hostPage, role: string) => {
      const audioConstraints = await page.evaluate(() => {
        const audio = (window as any).capturedStreams?.filter((s: any) => s.stream.getAudioTracks().length > 0);
        const c = audio?.[0]?.constraints?.audio; // first audio capture = startMediaAndCall
        return c && typeof c === 'object' ? c : null;
      });
      console.log(`[TEST] ${role} initial mic constraints: ${JSON.stringify(audioConstraints)}`);
      expect(audioConstraints).not.toBeNull();
      expect(audioConstraints.echoCancellation).toBe(true);
      expect(audioConstraints.noiseSuppression).toBe(true);
      expect(audioConstraints.autoGainControl).toBe(true);
    };
    await checkInitialAec(hostPage, 'Host');
    await checkInitialAec(peerPage, 'Peer');

    // 6. switchMic regression: the new capture must STILL request AEC alongside
    //    the chosen deviceId. (This is the exact line the echo fix changed.)
    await hostPage.click('button[aria-label="Devices"]');
    await hostPage.waitForSelector('.device-menu');
    await hostPage.screenshot({ path: testInfo.outputPath('3_device_menu.png') });
    await hostPage.selectOption('.device-menu select', 'mock-mic-2');
    await hostPage.waitForTimeout(1500);
    const switched = await hostPage.evaluate(() => {
      const audio = (window as any).capturedStreams?.filter((s: any) => s.stream.getAudioTracks().length > 0);
      return audio?.[audio.length - 1]?.constraints ?? null;
    });
    console.log(`[TEST] Host switchMic constraints: ${JSON.stringify(switched)}`);
    expect(switched).not.toBeNull();
    expect(switched.audio.deviceId).toEqual({ exact: 'mock-mic-2' });
    expect(switched.audio.echoCancellation).toBe(true);
    expect(switched.audio.noiseSuppression).toBe(true);
    expect(switched.audio.autoGainControl).toBe(true);
    await hostPage.click('.device-close');

    // 7. Exactly one remote-stream sink; no stray <audio> elements.
    const counts = await hostPage.evaluate(() => ({
      audios: document.querySelectorAll('audio').length,
      remoteVideos: Array.from(document.querySelectorAll('video.remote-video'))
        .filter(v => (v as HTMLVideoElement).srcObject !== null).length,
    }));
    console.log(`[TEST] Host media sinks: ${JSON.stringify(counts)}`);
    expect(counts.audios).toBe(0);
    expect(counts.remoteVideos).toBe(1);

    // 8. Remote camera-off — REGRESSION GUARD for the audio-sink bug.
    //    The placeholder must OVERLAY the remote <video> (the sole audio sink),
    //    not replace it. Pre-fix, the <video> was unmounted here, silencing
    //    remote audio (and it never returned because ontrack doesn't re-fire).
    //    NB: fake-media Chromium keeps sending frames on a disabled track, so
    //    the camera-off DETECTION (fps→0) is forced via mockRemoteVideoOff
    //    below; this test proves the fps-0→overlay→audio-survives half, not the
    //    real "disabled track → fps 0" link.
    await peerPage.click('button[aria-label="Camera off"]');
    await hostPage.evaluate(() => { (window as any).mockRemoteVideoOff = true; });

    await expect(hostPage.locator('.video-off-state')).toBeVisible({ timeout: 8000 });
    await hostPage.screenshot({ path: testInfo.outputPath('4_camera_off.png') });

    // The audio sink (<video>) is still mounted, with srcObject, unmuted.
    const audioSinkAlive = await hostPage.evaluate(() => {
      const v = document.querySelector('video.remote-video') as HTMLVideoElement | null;
      return !!v && v.srcObject !== null && !v.muted;
    });
    expect(audioSinkAlive).toBe(true);
    console.log('[TEST] remote audio sink survives camera-off ✓');

    // Transport sanity: inbound audio track still live.
    const audioTrackLive = await hostPage.evaluate(() => {
      const pc = (window as any).peerConnections?.[0];
      const r = pc?.getReceivers().find((x: any) => x.track?.kind === 'audio');
      return r ? r.track.enabled && r.track.readyState === 'live' : false;
    });
    expect(audioTrackLive).toBe(true);

    // Camera back on → the same <video> still holds its srcObject (video resumes
    // rather than going permanently black).
    await peerPage.click('button[aria-label="Camera on"]');
    await hostPage.evaluate(() => { (window as any).mockRemoteVideoOff = false; });
    await expect(hostPage.locator('.video-off-state')).not.toBeVisible();
    const videoResumed = await hostPage.evaluate(() => {
      const v = document.querySelector('video.remote-video') as HTMLVideoElement | null;
      return !!v && v.srcObject !== null;
    });
    expect(videoResumed).toBe(true);
    console.log('[TEST] remote video resumes after camera-on ✓');

    // 9. Bidirectional E2EE chat.
    await hostPage.click('button[aria-label="Chat"]');
    await hostPage.fill('.chat-input input', 'Hello Bob!');
    await hostPage.click('.chat-input button[type="submit"]');
    await peerPage.click('button[aria-label="Chat"]');
    await expect(peerPage.locator('.msg-them .bubble')).toHaveText('Hello Bob!', { timeout: 5000 });
    await peerPage.fill('.chat-input input', 'Hey Alice, E2EE works!');
    await peerPage.click('.chat-input button[type="submit"]');
    await expect(hostPage.locator('.msg-them .bubble')).toHaveText('Hey Alice, E2EE works!', { timeout: 5000 });
    await hostPage.screenshot({ path: testInfo.outputPath('5_chat_active.png') });

    // 10. Safety code (SAS). The real security property is that both peers
    //     independently derive the SAME 5 digits from the ECDH exchange — that
    //     assertion below is the meaningful one. The "Codes match" → verified
    //     class transition is just UI-state smoke.
    const hostCode = await hostPage.locator('.security-pill .sas-mini').textContent();
    const peerCode = await peerPage.locator('.security-pill .sas-mini').textContent();
    console.log(`[TEST] SAS host=${hostCode} peer=${peerCode}`);
    expect(hostCode).toMatch(/^\d{5}$/);
    expect(hostCode).toBe(peerCode);
    await hostPage.click('.security-pill');
    await expect(hostPage.locator('.sas-card')).toBeVisible();
    await hostPage.click('button:has-text("Codes match")');
    await expect(hostPage.locator('.security-pill')).toHaveClass(/verified/);

    // 11. Call-end cleanup: both redirect home, all captured tracks ended.
    await hostPage.click('button[aria-label="End call"]');
    await hostPage.waitForURL('**/');
    await peerPage.waitForURL('**/', { timeout: 10000 });
    const tracksStopped = await hostPage.evaluate(() => {
      const audio = (window as any).capturedStreams?.filter((s: any) => s.stream.getAudioTracks().length > 0);
      if (!audio?.length) return true;
      return audio.every((s: any) => s.stream.getTracks().every((t: any) => t.readyState === 'ended'));
    });
    expect(tracksStopped).toBe(true);

    await browser.close();
  });
});
