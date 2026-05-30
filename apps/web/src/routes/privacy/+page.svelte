<script lang="ts">
  import { goto } from '$app/navigation';
</script>

<svelte:head>
  <title>Privacy & security — Alfajer</title>
  <meta name="description" content="What Alfajer does and doesn't see. The honest answer to 'is this app private?'" />
</svelte:head>

<article class="prose">
  <button class="back" onclick={() => history.length > 1 ? history.back() : goto('/')}>← Back</button>

  <h1>Privacy &amp; security</h1>
  <p class="lede">
    Alfajer is built so the people who run it — including the developer — can't see your calls or read your messages.
    This page tells you exactly how that works and the small number of things you should still verify yourself.
  </p>

  <h2>What's on our servers (the short answer)</h2>
  <ul>
    <li><strong>No accounts.</strong> You don't sign up. We don't know your email, phone number, or name.</li>
    <li><strong>No database.</strong> Rooms exist only in the signaling server's memory while a call is active. When everyone hangs up, the room is gone. A server restart wipes everything that ever existed in it.</li>
    <li><strong>No logs of your conversation.</strong> The signaling server is configured to never write your messages, your IP, your room code, or your peer's identifier to disk or to console output in production.</li>
    <li><strong>No analytics, no cookies, no third-party trackers.</strong> Nothing on the page calls out to Google Analytics, Facebook Pixel, or anything similar. We don't set cookies.</li>
    <li><strong>No call history.</strong> When the call ends, both peers' sessionStorage is cleared. There is nothing to "delete" because nothing was kept.</li>
  </ul>

  <h2>How your call is encrypted</h2>
  <p>
    Every Alfajer call has at least two encryption layers; some calls get a third.
  </p>
  <ul>
    <li>
      <strong>Layer 1 — WebRTC DTLS-SRTP.</strong> This is the encryption that comes with the browser itself. Both video and audio are
      encrypted directly from your browser to your peer's browser. Neither our signaling server nor our TURN relay can decrypt them.
      This is the same encryption used by Google Meet, WhatsApp calls, and every other modern WebRTC product.
    </li>
    <li>
      <strong>Layer 2 — App-level frame encryption (when both browsers support it).</strong> When both your browser and your peer's
      browser support the modern <code>RTCRtpScriptTransform</code> API, we add AES-256-GCM encryption on each <strong>video and
      audio</strong> frame before it reaches WebRTC. The keys are derived from an Elliptic-Curve Diffie-Hellman exchange and run
      through HKDF-SHA-256 to produce <em>separate keys per direction and per media kind</em> — four independent keys total. Even
      if DTLS-SRTP were ever broken in the future, your video and audio would still be protected by this independent layer.
      Each kind preserves only what the packetizer needs unencrypted: 10 bytes for video payload descriptors, 1 byte for the
      Opus TOC in audio. Everything after that is ciphertext.
    </li>
    <li>
      <strong>In-call chat uses its own dedicated key.</strong> Text messages are encrypted with a separate AES-GCM key derived from
      the same ECDH exchange, with a random IV per message. The signaling server only ever sees opaque ciphertext. Messages typed
      before the encryption key is ready are <em>queued in your browser</em>; they are never sent in cleartext.
    </li>
  </ul>

  <h2>The trust assumptions you should know about</h2>
  <p>
    These aren't bugs — they're inherent to any privacy-focused web app and the reason a strict reviewer would still treat Alfajer as
    "good for personal use" rather than "appropriate for high-risk activism."
  </p>

  <h3>1. The browser downloads the app code from our server</h3>
  <p>
    Every time you open the page, your browser fetches the JavaScript that does the encryption. If our deployment pipeline,
    Cloudflare account, or domain were compromised, an attacker could in theory serve a tampered version that bypasses encryption.
    This is true of every browser-delivered E2EE app, including Signal Web, Proton Mail web, and Bitwarden web. The native equivalent
    would be a dedicated mobile app reviewed and pinned by the platform's store — which Alfajer isn't yet.
  </p>
  <p>
    What we do to reduce this risk: a strict Content Security Policy locks the app down to its own origin, HSTS-preload prevents
    HTTPS-downgrade attacks, CAA records pin which certificate authorities can issue certificates for our domain, DNSSEC stops DNS
    spoofing, and the Cloudflare account has two-factor authentication. None of these eliminate the trust assumption — they just
    raise the bar on how an attacker could exploit it.
  </p>

  <h3>2. The 5-digit safety code only works if you actually check it</h3>
  <p>
    When the call is connected, the security pill in the top-left shows a 5-digit code. <strong>Both you and your peer should see the
    same five digits.</strong> Read them aloud over the call. If they match, you've verified that nobody (not even a hypothetical
    compromised signaling server) is sitting between you. Click <em>"Codes match"</em> on the security card to acknowledge that you
    verified them; the badge turns green and your peer's identity is then cryptographically confirmed.
  </p>
  <p>
    If you skip this step, the call is still encrypted, but you have no way to know you're encrypted to the right person rather than
    to a sophisticated attacker. For a casual chat with a friend you already know is on the line, this is usually fine. For anything
    you'd be uncomfortable seeing screenshot-published, do the comparison.
  </p>

  <h3>3. The room code is a "bearer secret"</h3>
  <p>
    Anyone with the 9-digit room code can attempt to join. This is by design — we have no accounts and no other identity layer.
    The protections around this:
  </p>
  <ul>
    <li>The host explicitly approves every join via the "knock" dialog before any media starts flowing.</li>
    <li>Once two peers are connected, the room is sealed; a third attempt is rejected with WebSocket close code 1008.</li>
    <li>A single attacker is rate-limited to 30 WebSocket connections per minute per IP — brute-forcing the 1-billion-code space
        is computationally infeasible.</li>
    <li>The share screen carries an explicit warning so you know the code should travel through a trusted channel.</li>
  </ul>
  <p>Share the code only with the person you want to call.</p>

  <h3>4. We haven't paid for an external penetration test</h3>
  <p>
    Every technical control we know how to implement is implemented and continuously regression-tested in CI. But a paid human
    penetration tester finds classes of bugs that automated tests don't (business-logic flaws, race conditions during reconnect,
    supply-chain audit, etc.). Alfajer has not had this kind of audit. For activists, journalists facing state-level adversaries,
    or any communication where the consequences of compromise would be severe, a mature audited messenger like Signal is the safer
    choice.
  </p>

  <h2>What you can do</h2>
  <ul>
    <li>Compare the 5-digit safety code with your peer at the start of each call.</li>
    <li>Share room codes only through channels you already trust.</li>
    <li>If you see the security badge turn red ("Codes don't match"), end the call immediately.</li>
    <li>Use a current browser — security improvements ship constantly.</li>
  </ul>

  <h2>How to verify these claims yourself</h2>
  <p>
    The application source code is in a private GitHub repository at <code>ala-obeidat/alfajer</code>. The crypto layer is small
    (~150 lines of glue around the browser's standardized Web Crypto API) and worth reading if you have the inclination. We don't
    expect users to take privacy claims on trust alone — every claim on this page corresponds to specific code you could read or
    a HTTP header you could inspect.
  </p>

  <p class="foot">
    Last updated when this page was published. No version of Alfajer has ever stored your personal data, your messages, or your call
    metadata. When that changes — if it ever does — this page will say so before the change ships.
  </p>
</article>

<style>
  .prose {
    max-inline-size: 42rem;
    margin-inline: auto;
    padding: 2rem 1rem 4rem;
    color: var(--text-primary);
    line-height: 1.65;
  }

  .back {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-strong);
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    font-size: 0.9rem;
    margin-block-end: 1.25rem;
  }
  .back:hover { background: var(--code-bg); color: var(--text-primary); }

  .prose h1 {
    font-size: clamp(1.8rem, 4vw, 2.4rem);
    letter-spacing: -0.02em;
    margin-block: 0 0.6rem;
  }
  .prose h2 {
    font-size: clamp(1.2rem, 3vw, 1.5rem);
    letter-spacing: -0.01em;
    margin-block: 2.2rem 0.6rem;
  }
  .prose h3 {
    font-size: 1.05rem;
    margin-block: 1.4rem 0.4rem;
    color: var(--text-secondary);
  }

  .prose p, .prose li { font-size: 0.97rem; }
  .prose .lede {
    font-size: 1.05rem;
    color: var(--text-secondary);
    margin-block-end: 0.4rem;
  }
  .prose ul { padding-inline-start: 1.25rem; }
  .prose li { margin-block: 0.4rem; }

  .prose code {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    font-size: 0.88em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .prose strong { color: var(--text-primary); }

  .foot {
    margin-block-start: 3rem;
    padding-block-start: 1.2rem;
    border-block-start: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.88rem;
  }
</style>
