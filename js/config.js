
const servers={
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
}
const firebaseConfig = {
    apiKey: "AIzaSyBG5vZ8KxQa0AFiojtIsJECFpnKp_dI5fc",
    authDomain: "al-fajer-a8af0.firebaseapp.com",
    projectId: "al-fajer-a8af0",
    storageBucket: "al-fajer-a8af0.appspot.com",
    messagingSenderId: "49883731089",
    appId: "1:49883731089:web:4b7d921832b6183411db30",
    measurementId: "G-F1KT0J96S5"
  };
 
  export  const config={
    production:true,
    rtc:servers,
    firebase:firebaseConfig,
    localStream: null,
    remoteStream:null,
    enableVideo:true,
    enableAudio:true
  }
  