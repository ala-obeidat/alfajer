let cryptoKey: CryptoKey | null = null;

onmessage = async (event) => {
  if (event.data.type === 'setKey') {
    cryptoKey = event.data.key;
  } else if (event.data.rtcpTransform) {
    // Handling direct RTCRtpScriptTransform event hook if supported
    // But typically it's handled via the browser's `onrtctransform` global handler
  }
};

// WebRTC E2EE Hook
(self as any).onrtctransform = (event: any) => {
  const transformer = event.transformer;
  const side = transformer.options.side;
  
  transformer.reader = transformer.readable.getReader();
  transformer.writer = transformer.writable.getWriter();

  const processFrames = async () => {
    while (true) {
      const { done, value: frame } = await transformer.reader.read();
      if (done) break;

      if (!cryptoKey) {
        // MUST drop frames if key is not ready, otherwise unencrypted frames 
        // reach the decoder and crash it.
        continue;
      }

      const timestamp = frame.timestamp;
      
      // Derive IV: just use timestamp to ensure exact match across peers
      // (SSRC metadata can sometimes be stripped or missing on receiver)
      const iv = new ArrayBuffer(12);
      const view = new DataView(iv);
      view.setUint32(0, timestamp);
      // Last 8 bytes remain 0
      
      // Leave first 10 bytes unencrypted (codec payload descriptor) to prevent packetizer crash
      const headerSize = 10;
      const dataView = new Uint8Array(frame.data);
      if (dataView.length <= headerSize) {
        // Too small to encrypt
        await transformer.writer.write(frame);
        continue;
      }

      const unencryptedHeader = dataView.slice(0, headerSize);
      const payloadToEncrypt = dataView.slice(headerSize);
      
      if (side === 'sender') {
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          cryptoKey,
          payloadToEncrypt
        );
        const encryptedView = new Uint8Array(encrypted);
        const newData = new Uint8Array(unencryptedHeader.length + encryptedView.length);
        newData.set(unencryptedHeader, 0);
        newData.set(encryptedView, unencryptedHeader.length);
        frame.data = newData.buffer;
      } else {
        try {
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            payloadToEncrypt
          );
          const decryptedView = new Uint8Array(decrypted);
          const newData = new Uint8Array(unencryptedHeader.length + decryptedView.length);
          newData.set(unencryptedHeader, 0);
          newData.set(decryptedView, unencryptedHeader.length);
          frame.data = newData.buffer;
        } catch (e) {
          // Decryption failed (wrong key, bad IV, or corrupted)
          console.error('[Worker] Decryption failed for frame', timestamp, e);
          continue; 
        }
      }

      await transformer.writer.write(frame);
    }
  };

  processFrames();
};
