import { test, expect, chromium, firefox } from '@playwright/test';

test.setTimeout(60000);

// Helper to inject spys/mocks for MediaDevices and RTCPeerConnection
const injectSpysAndMockMic = async (p: any) => {
  await p.addInitScript(() => {
    // Guard against pages like about:blank where mediaDevices is not available
    if (navigator.mediaDevices) {
      // 1. Mock enumerateDevices to return mock mic and speaker directly
      navigator.mediaDevices.enumerateDevices = async () => {
        return [
          {
            deviceId: 'mock-mic-2', kind: 'audioinput',
            label: 'Mock External Microphone (AEC)', groupId: 'mock-group',
            toJSON: () => ({}),
          } as any,
          {
            deviceId: 'mock-speaker-2', kind: 'audiooutput',
            label: 'Mock Bluetooth Speaker', groupId: 'mock-group-spk',
            toJSON: () => ({}),
          } as any
        ];
      };

      // 2. Mock setSinkId on HTMLMediaElement prototype
      (window as any).sinkIdsApplied = [];
      HTMLMediaElement.prototype.setSinkId = async function(id) {
        (window as any).sinkIdsApplied.push(id);
        return Promise.resolve(); // Mock successful execution to allow localStorage writes
      };

      // 3. Spy on getUserMedia
      const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      (window as any).capturedStreams = [];
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        let actual = constraints;
        const audio = constraints && (constraints.audio as any);
        if (audio && typeof audio === 'object' && audio.deviceId && audio.deviceId.exact === 'mock-mic-2') {
          actual = { ...constraints, audio: { ...audio, deviceId: { exact: 'default' } } };
        }
        const stream = await originalGUM(actual);
        (window as any).capturedStreams.push({ constraints, stream });
        return stream;
      };
    }

    // 4. Spy on RTCPeerConnection and createOffer
    if (window.RTCPeerConnection) {
      const OriginalPC = window.RTCPeerConnection;
      (window as any).peerConnections = [];
      // @ts-ignore
      window.RTCPeerConnection = function (config) {
        const pc = new OriginalPC(config);
        (window as any).peerConnections.push(pc);

        // Force connectionState to return 'connected' if mocked, otherwise fallback to native
        const originalState = Object.getOwnPropertyDescriptor(OriginalPC.prototype, 'connectionState')?.get;
        Object.defineProperty(pc, 'connectionState', {
          get: () => {
            if ((window as any).mockConnectedState === 'connected') {
              return 'connected';
            }
            return originalState ? originalState.call(pc) : pc.iceConnectionState;
          },
          configurable: true
        });

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

        const originalCreateOffer = pc.createOffer.bind(pc);
        (window as any).createOfferCalls = [];
        pc.createOffer = async function(options) {
          (window as any).createOfferCalls.push(options);
          return originalCreateOffer(options);
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = OriginalPC.prototype;
    }
  });
};

// Helper to spy on WebSocket creation
const injectWebSocketSpy = async (p: any) => {
  await p.addInitScript(() => {
    if (!window.WebSocket) return;
    const OriginalWS = window.WebSocket;
    (window as any).webSockets = [];
    // @ts-ignore
    window.WebSocket = function (url, protocols) {
      const ws = protocols === undefined ? new OriginalWS(url) : new OriginalWS(url, protocols);
      (window as any).webSockets.push(ws);
      return ws;
    };
    window.WebSocket.prototype = OriginalWS.prototype;
    // Copy all WebSocket static constants
    window.WebSocket.CONNECTING = OriginalWS.CONNECTING;
    window.WebSocket.OPEN = OriginalWS.OPEN;
    window.WebSocket.CLOSING = OriginalWS.CLOSING;
    window.WebSocket.CLOSED = OriginalWS.CLOSED;
  });
};

test.describe('Alfajer Deep Functional Test Pass - Second Phase', () => {

  test('Focus 2: Safari PWA install banner on REAL WebKit', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit', 'Runs only on WebKit');

    await page.goto('/');

    // Check PWA static assets are reachable
    const manifestRes = await page.request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifestJson = await manifestRes.json();
    expect(manifestJson.short_name).toBe('Alfajer');

    const iconRes = await page.request.get('/pwa-192x192.png');
    expect(iconRes.status()).toBe(200);

    const icon512Res = await page.request.get('/pwa-512x512.png');
    expect(icon512Res.status()).toBe(200);

    const faviconRes = await page.request.get('/favicon.svg');
    expect(faviconRes.status()).toBe(200);

    // Verify PWA mobile-web-app metadata tags in head
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', /.*\/manifest\.webmanifest$/);
    
    const appleTouchIcon192 = page.locator('link[rel="apple-touch-icon"][sizes="192x192"]');
    await expect(appleTouchIcon192).toHaveAttribute('href', /.*\/pwa-192x192\.png$/);

    const appCapable = page.locator('meta[name="apple-mobile-web-app-capable"]');
    await expect(appCapable).toHaveAttribute('content', 'yes');

    // WebKit manual banner eligibility test
    // Standalone needs to be false for banner to show
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => false });
    });
    await page.reload();

    const iosBanner = page.locator('.install-banner.ios');
    await expect(iosBanner).toBeVisible();
    await expect(page.locator('button:has-text("Install")')).not.toBeVisible();
    
    // Capture screenshot of real WebKit PWA banner
    await page.screenshot({ path: testInfo.outputPath('webkit_pwa_banner.png') });

    // Dismiss and verify persistence
    await page.click('button[aria-label="Dismiss install instructions"]');
    await expect(iosBanner).not.toBeVisible();

    const dismissedAt = await page.evaluate(() => localStorage.getItem('alfajer.installDismissedAt'));
    expect(dismissedAt).not.toBeNull();
    
    await page.reload();
    await expect(iosBanner).not.toBeVisible();
  });

  test('Focus 1 & Priority 1: Speaker SinkId, Mic AEC, & Perm Denial on Chromium', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Runs only on Chromium');

    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    // TEST A: getUserMedia denial flow
    const denyContext = await browser.newContext({
      permissions: [] // No camera or microphone permissions granted
    });
    const denyPage = await denyContext.newPage();
    
    // Force getUserMedia to throw NotAllowedError to verify denial toast path
    await denyPage.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    });

    await denyPage.goto('/');
    await denyPage.fill('input[placeholder="What should we call you?"]', 'DenyUser');
    await denyPage.click('button:has-text("Start new call")');
    await denyPage.waitForURL(/\/call\/\d+/);

    // Assert that the permission error toast path executes and displays
    const errorToast = denyPage.locator('.toast:has-text("Could not access camera/microphone")');
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    console.log('[TEST] getUserMedia Denied toast is displayed correctly');
    await denyContext.close();

    // TEST B: Loopback Call with Speaker & MIC constraints verification
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    hostPage.on('console', msg => console.log(`[HOST]: ${msg.text()}`));
    hostPage.on('pageerror', err => console.log(`[HOST ERROR]: ${err}`));
    peerPage.on('console', msg => console.log(`[PEER]: ${msg.text()}`));
    peerPage.on('pageerror', err => console.log(`[PEER ERROR]: ${err}`));

    await injectSpysAndMockMic(hostPage);
    await injectSpysAndMockMic(peerPage);

    // Host starts a room
    await hostPage.goto('/');
    await hostPage.fill('input[placeholder="What should we call you?"]', 'Alice');
    await hostPage.click('button:has-text("Start new call")');
    await hostPage.waitForURL(/\/call\/\d+/);
    const roomId = hostPage.url().match(/\/call\/(\d+)/)?.[1];

    // Wait for Host media to be fully ready before Peer joins
    await hostPage.waitForFunction(() => {
      const video = document.querySelector('.local-video') as HTMLVideoElement;
      return video && video.srcObject !== null;
    }, { timeout: 15000 });

    // Peer joins
    await peerPage.goto(`/call/${roomId}`);
    await peerPage.fill('input[placeholder="Your nickname"]', 'Bob');
    await peerPage.click('button:has-text("Ask to join")');

    // Accept knock
    const acceptBtn = hostPage.locator('button:has-text("Accept")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    // Wait for connection
    await expect(hostPage.locator('.security-pill')).toBeVisible({ timeout: 15000 });

    // Open devices menu
    await hostPage.click('button[aria-label="Devices"]');
    await hostPage.waitForSelector('.device-menu');

    // Select mock speaker output
    const speakerSelect = hostPage.locator('.device-menu select').nth(1);
    await speakerSelect.selectOption('mock-speaker-2');
    await hostPage.waitForTimeout(1000);

    // Verify setSinkId invocation
    const sinkIds = await hostPage.evaluate(() => (window as any).sinkIdsApplied);
    console.log('[TEST] Speaker setSinkId calls:', JSON.stringify(sinkIds));
    expect(sinkIds).toContain('mock-speaker-2');

    // Verify speaker choice persists to localStorage
    const savedSpk = await hostPage.evaluate(() => localStorage.getItem('alfajer.pref.speakerId'));
    expect(savedSpk).toBe('mock-speaker-2');

    // Verify mic AEC track settings are still active after speaker change
    const hostMicSettings = await hostPage.evaluate(() => {
      const audio = (window as any).capturedStreams?.filter((s: any) => s.stream.getAudioTracks().length > 0);
      return audio?.[audio.length - 1]?.stream.getAudioTracks()[0]?.getSettings() ?? null;
    });
    console.log('[TEST] Host mic settings after speaker switch:', JSON.stringify(hostMicSettings));
    expect(hostMicSettings.echoCancellation).toBe(true);
    expect(hostMicSettings.noiseSuppression).toBe(true);
    expect(hostMicSettings.autoGainControl).toBe(true);

    // Verify restoration of preferred speaker sink on reconnect event
    await hostPage.evaluate(() => {
      (window as any).sinkIdsApplied = [];
      (window as any).mockConnectedState = 'connected';
      const pc = (window as any).peerConnections?.[0];
      if (pc) {
        pc.dispatchEvent(new Event('connectionstatechange'));
      }
    });
    await hostPage.waitForTimeout(1000);
    const sinkIdsAfterReconnect = await hostPage.evaluate(() => (window as any).sinkIdsApplied);
    console.log('[TEST] Speaker setSinkId calls after reconnect event:', JSON.stringify(sinkIdsAfterReconnect));
    expect(sinkIdsAfterReconnect).toContain('mock-speaker-2');

    await hostPage.click('.device-close');
    await browser.close();
  });

  test('Priority 1 & 2: Resilience, WebSocket Chat Capture, and SAS warning on Chromium', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Runs only on Chromium');

    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    hostPage.on('console', msg => console.log(`[HOST]: ${msg.text()}`));
    hostPage.on('pageerror', err => console.log(`[HOST ERROR]: ${err}`));
    peerPage.on('console', msg => console.log(`[PEER]: ${msg.text()}`));
    peerPage.on('pageerror', err => console.log(`[PEER ERROR]: ${err}`));

    // Spy on WS frames on Host
    const hostWsFramesSent: string[] = [];
    hostPage.on('websocket', ws => {
      ws.on('framesent', ({ payload }) => {
        hostWsFramesSent.push(payload as string);
      });
    });

    await injectSpysAndMockMic(hostPage);
    await injectSpysAndMockMic(peerPage);
    await injectWebSocketSpy(peerPage);

    // 1. Establish Loopback Call
    await hostPage.goto('/');
    await hostPage.fill('input[placeholder="What should we call you?"]', 'Alice');
    await hostPage.click('button:has-text("Start new call")');
    await hostPage.waitForURL(/\/call\/\d+/);
    const roomId = hostPage.url().match(/\/call\/(\d+)/)?.[1];

    // Wait for Host media to be fully ready before Peer joins
    await hostPage.waitForFunction(() => {
      const video = document.querySelector('.local-video') as HTMLVideoElement;
      return video && video.srcObject !== null;
    }, { timeout: 15000 });

    await peerPage.goto(`/call/${roomId}`);
    await peerPage.fill('input[placeholder="Your nickname"]', 'Bob');
    await peerPage.click('button:has-text("Ask to join")');

    const acceptBtn = hostPage.locator('button:has-text("Accept")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    await expect(hostPage.locator('.security-pill')).toBeVisible({ timeout: 15000 });

    // 2. Chat WebSocket encryption check
    await hostPage.click('button[aria-label="Chat"]');
    await hostPage.fill('.chat-input input', 'SECRET MESSAGE');
    await hostPage.click('.chat-input button[type="submit"]');
    await hostPage.waitForTimeout(1000);

    console.log('[TEST] ws frames sent:', hostWsFramesSent);
    const chatFrame = hostWsFramesSent.find(f => f.includes('"chat"'));
    expect(chatFrame).toBeDefined();
    expect(chatFrame).not.toContain('SECRET MESSAGE');
    
    const parsedFrame = JSON.parse(chatFrame!);
    expect(parsedFrame.enc).toBe(true);
    expect(parsedFrame.iv).toBeDefined();
    expect(parsedFrame.payload).toBeDefined();

    // 3. Forged plaintext chat drop flow
    await peerPage.click('button[aria-label="Chat"]');
    await peerPage.evaluate(() => {
      const ws = (window as any).webSockets?.find((w: any) => w.url.includes('/call/'));
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: 'chat',
            enc: false,
            payload: 'ATTACK: Forged plaintext message'
          })
        });
      }
    });
    await expect(peerPage.locator('.bubble:has-text("ATTACK")')).not.toBeVisible();
    console.log('[TEST] Forged plaintext chat was successfully dropped');

    // 4. SAS Mismatch Flow
    await hostPage.click('.security-pill');
    await expect(hostPage.locator('.sas-card')).toBeVisible();
    await hostPage.click('button:has-text("don\'t match")');
    await expect(hostPage.locator('.security-pill')).toHaveClass(/mismatch/);
    await expect(hostPage.locator('.sas-state-confirm.mismatch')).toBeVisible();
    await expect(hostPage.locator('.sas-state-confirm.mismatch')).toContainText('Code mismatch reported');
    console.log('[TEST] SAS mismatch warning state triggered successfully');

    // Undo mismatch choice
    await hostPage.click('.sas-state-confirm.mismatch button.link:has-text("I made a mistake")');
    await expect(hostPage.locator('.security-pill')).not.toHaveClass(/mismatch/);
    await hostPage.click('.sas-card .ctrl'); // Close sas card

    // 5. Network drop & tryIceRestart flow
    // Simulate ICE Connection failure
    await hostPage.evaluate(() => {
      const pc = (window as any).peerConnections?.[0];
      if (pc) {
        Object.defineProperty(pc, 'iceConnectionState', { get: () => 'failed', configurable: true });
        pc.dispatchEvent(new Event('iceconnectionstatechange'));
      }
    });

    await expect(hostPage.locator('.toast:has-text("Reconnecting")')).toBeVisible({ timeout: 5000 });

    const createOfferOptions = await hostPage.evaluate(() => (window as any).createOfferCalls);
    const iceRestartOptionSent = createOfferOptions.some((opt: any) => opt && opt.iceRestart === true);
    expect(iceRestartOptionSent).toBe(true);
    console.log('[TEST] tryIceRestart successfully initiated ICE restart offer');

    await browser.close();
  });

  test('Firefox E2EE fallback validation', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'firefox', 'Runs only on Firefox');

    const browser = await firefox.launch({
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.peerconnection.ice.loopback': true,
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.peerconnection.ice.ipv6_enabled': true
      }
    });

    const hostContext = await browser.newContext();
    const peerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    hostPage.on('console', msg => console.log(`[HOST]: ${msg.text()}`));
    hostPage.on('pageerror', err => console.log(`[HOST ERROR]: ${err}`));
    peerPage.on('console', msg => console.log(`[PEER]: ${msg.text()}`));
    peerPage.on('pageerror', err => console.log(`[PEER ERROR]: ${err}`));

    await injectSpysAndMockMic(hostPage);
    await injectSpysAndMockMic(peerPage);

    // Pre-mock mockConnectedState to 'connected' and disable RTCRtpScriptTransform to force DTLS-SRTP fallback
    await hostPage.addInitScript(() => {
      (window as any).mockConnectedState = 'connected';
      delete (window as any).RTCRtpScriptTransform;
    });
    await peerPage.addInitScript(() => {
      (window as any).mockConnectedState = 'connected';
      delete (window as any).RTCRtpScriptTransform;
    });

    // 1. Establish call in Firefox
    await hostPage.goto('/');
    await hostPage.fill('input[placeholder="What should we call you?"]', 'AliceFirefox');
    await hostPage.click('button:has-text("Start new call")');
    await hostPage.waitForURL(/\/call\/\d+/);
    const roomId = hostPage.url().match(/\/call\/(\d+)/)?.[1];

    // Wait for Host media to be fully ready before Peer joins
    await hostPage.waitForFunction(() => {
      const video = document.querySelector('.local-video') as HTMLVideoElement;
      return video && video.srcObject !== null;
    }, { timeout: 15000 });

    await peerPage.goto(`/call/${roomId}`);
    await peerPage.fill('input[placeholder="Your nickname"]', 'BobFirefox');
    await peerPage.click('button:has-text("Ask to join")');

    const acceptBtn = hostPage.locator('button:has-text("Accept")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    // Dispatch connection state changes now that peer has joined
    await hostPage.waitForTimeout(2000);
    await hostPage.evaluate(() => {
      const pc = (window as any).peerConnections?.[0];
      if (pc) {
        pc.dispatchEvent(new Event('connectionstatechange'));
      }
    });
    await peerPage.evaluate(() => {
      const pc = (window as any).peerConnections?.[0];
      if (pc) {
        pc.dispatchEvent(new Event('connectionstatechange'));
      }
    });

    // Capture screenshots to help diagnose state in case of connection issues
    await hostPage.screenshot({ path: testInfo.outputPath('firefox_host.png') });
    await peerPage.screenshot({ path: testInfo.outputPath('firefox_peer.png') });

    // Wait for connection
    await expect(hostPage.locator('.security-pill')).toBeVisible({ timeout: 15000 });

    // Since Firefox does NOT support RTCRtpScriptTransform, it must fallback gracefully to DTLS-SRTP.
    await hostPage.click('.security-pill');
    await expect(hostPage.locator('.sas-card')).toBeVisible();
    await expect(hostPage.locator('.sas-card')).toContainText('DTLS-SRTP only');
    console.log('[TEST] Firefox successfully fallback to DTLS-SRTP only mode');

    await browser.close();
  });

  test('Priority 1: 3rd Joiner Rejection and Knock Reject Flow', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Runs only on Chromium');

    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const hostPage = await hostContext.newPage();
    const peerPage = await peerContext.newPage();

    hostPage.on('console', msg => console.log(`[HOST]: ${msg.text()}`));
    hostPage.on('pageerror', err => console.log(`[HOST ERROR]: ${err}`));
    peerPage.on('console', msg => console.log(`[PEER]: ${msg.text()}`));
    peerPage.on('pageerror', err => console.log(`[PEER ERROR]: ${err}`));

    await injectSpysAndMockMic(hostPage);
    await injectSpysAndMockMic(peerPage);
    await injectWebSocketSpy(hostPage);
    await injectWebSocketSpy(peerPage);

    // 1. Start call
    await hostPage.goto('/');
    await hostPage.fill('input[placeholder="What should we call you?"]', 'HostUser');
    await hostPage.click('button:has-text("Start new call")');
    await hostPage.waitForURL(/\/call\/\d+/);
    const roomId = hostPage.url().match(/\/call\/(\d+)/)?.[1];

    // Wait for Host media to be fully ready before Peer joins
    await hostPage.waitForFunction(() => {
      const video = document.querySelector('.local-video') as HTMLVideoElement;
      return video && video.srcObject !== null;
    }, { timeout: 15000 });

    // 2. Peer knocks
    await peerPage.goto(`/call/${roomId}`);
    await peerPage.fill('input[placeholder="Your nickname"]', 'Knocker');
    await peerPage.click('button:has-text("Ask to join")');

    // 3. Host rejects the knock
    const rejectBtn = hostPage.locator('button:has-text("Reject")');
    await expect(rejectBtn).toBeVisible({ timeout: 10000 });
    await rejectBtn.click();

    // 4. Verify Peer gets redirected back to home with reject warning toast
    await peerPage.waitForURL('**/');
    const rejectToast = peerPage.locator('.toast:has-text("Your request to join was rejected")');
    await expect(rejectToast).toBeVisible({ timeout: 5000 });
    console.log('[TEST] Knock rejection and redirect worked correctly');

    // Explicitly close signaling WebSockets from client to force server teardown
    await hostPage.evaluate(() => {
      (window as any).webSockets?.forEach((ws: any) => {
        if (ws.url.includes('/call/')) ws.close();
      });
    });
    await peerPage.evaluate(() => {
      (window as any).webSockets?.forEach((ws: any) => {
        if (ws.url.includes('/call/')) ws.close();
      });
    });

    // Navigate away to cleanly close WebSocket connections from both pages
    await hostPage.goto('/');
    await peerPage.goto('/');

    // Close pages explicitly to trigger immediate socket closure
    await hostPage.close();
    await peerPage.close();

    // Close the old contexts to cleanly close all WebSocket connections and wipe memory
    await hostContext.close();
    await peerContext.close();

    // Wait a brief moment for the signaling server to prune the room
    await new Promise(resolve => setTimeout(resolve, 16000));

    // Create fresh new contexts for host and peer
    const newHostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const newPeerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const newHostPage = await newHostContext.newPage();
    const newPeerPage = await newPeerContext.newPage();

    newHostPage.on('console', msg => console.log(`[NEW HOST]: ${msg.text()}`));
    newHostPage.on('pageerror', err => console.log(`[NEW HOST ERROR]: ${err}`));
    newPeerPage.on('console', msg => console.log(`[NEW PEER]: ${msg.text()}`));
    newPeerPage.on('pageerror', err => console.log(`[NEW PEER ERROR]: ${err}`));

    await injectSpysAndMockMic(newHostPage);
    await injectSpysAndMockMic(newPeerPage);

    // 5. Re-host a fresh room ID for the sealed room / 3rd joiner test
    await newHostPage.goto('/');
    await newHostPage.fill('input[placeholder="What should we call you?"]', 'HostUserTwo');
    await newHostPage.click('button:has-text("Start new call")');
    await newHostPage.waitForURL(/\/call\/\d+/);
    const secondRoomId = newHostPage.url().match(/\/call\/(\d+)/)?.[1];
    expect(secondRoomId).toBeDefined();

    await expect(newHostPage.locator('.room-code')).toBeVisible();

    // Wait for Host media to be fully ready before Peer joins
    await newHostPage.waitForFunction(() => {
      const video = document.querySelector('.local-video') as HTMLVideoElement;
      return video && video.srcObject !== null;
    }, { timeout: 15000 });

    // Peer 1 joins this room
    await newPeerPage.goto(`/call/${secondRoomId}`);
    await newPeerPage.fill('input[placeholder="Your nickname"]', 'PeerOne');
    await newPeerPage.click('button:has-text("Ask to join")');

    const acceptBtn2 = newHostPage.locator('button:has-text("Accept")');
    await expect(acceptBtn2).toBeVisible({ timeout: 10000 });
    await acceptBtn2.click();

    await expect(newHostPage.locator('.security-pill')).toBeVisible({ timeout: 15000 });

    // 6. 3rd Joiner Rejection: launch a 3rd client context and try to join
    const thirdContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const thirdPage = await thirdContext.newPage();
    await thirdPage.goto(`/call/${secondRoomId}`);
    await thirdPage.fill('input[placeholder="Your nickname"]', 'Charlie');
    await thirdPage.click('button:has-text("Ask to join")');

    // 3rd peer should receive a room-full reject toast and get redirected back to home
    await thirdPage.waitForURL('**/', { timeout: 10000 });
    const fullToast = thirdPage.locator('.toast:has-text("Room is full")');
    await expect(fullToast).toBeVisible({ timeout: 5000 });
    console.log('[TEST] 3rd joiner was successfully rejected from sealed call');

    await thirdContext.close();
    await newHostContext.close();
    await newPeerContext.close();
    await browser.close();
  });
});
