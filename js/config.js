
const servers={
  iceServers: [
    //Add stun servers
  ],
  iceCandidatePoolSize: 10,
}
const firebaseConfig = {
  //Add firebase config
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
  