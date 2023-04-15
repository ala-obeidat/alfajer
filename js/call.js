import { getAuth,signInAnonymously  } from 'https://www.gstatic.com/firebasejs/9.9.3/firebase-auth.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.9.3/firebase-app.js';
import { getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  onSnapshot } from 'https://www.gstatic.com/firebasejs/9.9.3/firebase-firestore.js'

import { config } from './config.js';
let endFun;
let callEnded=false;
let audioInputDevices = [];
let currentAudioInputIndex = 0;
let audioOutputDevices = [];
let currentAudioOutputIndex = 0;

export default class WebRTC{
  collectionName;db;rtc;openVideo;openAudio;auth;
  constructor(isVideo) {
    this.collectionName='calls';
    const app=initializeApp(config.firebase);
    this.auth=getAuth(app);
    this.db=getFirestore(app);
    this.rtc=null;
    config.enableVideo=isVideo;
    this.openVideo=true;
    this.openAudio=true;
  }
  end =async (callId) => {
    if(callEnded)
    {
      return;
    }
    else
    {
      callEnded=true;
    }
    console.log('Ending the call..',callId); 
    
    if(config.localStream){
      config.localStream.getTracks().forEach(track => track.stop());
    }
    if(config.remoteStream){
      config.remoteStream.getTracks().forEach(track => track.stop())
    }
    
        if(this.rtc){
          this.rtc.close();
        }
        if(callId)
        {
          const callDoc = doc(this.db, this.collectionName, callId);
          const callObj={
            status:'ended',
            endTime:new Date()
          }
          await updateDoc(callDoc,  callObj );
        }
      window.location.href= window.location.origin+'/thank.html';  
  };
  mute=(isAudio,callback)=>{
    let active=false;
    if(isAudio){
        config.localStream.getAudioTracks().forEach((track) => {
          this.openAudio=!this.openAudio;
          active=this.openAudio;  
          track.enabled =this.openAudio;
        });
    }else{
        config.localStream.getVideoTracks().forEach((track) => {
          this.openVideo=!this.openVideo;
          active=this.openVideo;  
          track.enabled =this.openVideo;
        });
    }
    if(callback)
      callback(active);
  };
  init = async (callback,answerCallback) => {
    var responseResult=await signInAnonymously(this.auth);
    console.log("Signed in as anonymous user:", responseResult.user);

    this.rtc= new RTCPeerConnection(config.rtc);
    config.answerCallback=answerCallback;
    try{
      config.localStream = await navigator.mediaDevices.getUserMedia({ video: config.enableVideo, audio: true });
    }catch(x){
      console.error(x);
    }
    
    config.remoteStream = new MediaStream();
  
    // Push tracks from local stream to peer connection
    config.localStream.getTracks().forEach((track) => {
      this.rtc.addTrack(track, config.localStream);
    });
    
    // Pull tracks from remote stream, add to video stream
    this.rtc.ontrack = (event) => { 
      event.streams[0].getTracks().forEach((track) => {
        config.remoteStream.addTrack(track);
      });
      if(config.answerCallback)
        config.answerCallback();
    };
    callback(config.localStream,config.remoteStream);
    endFun=this.end;
  };
  start = async (callback) => {
    // Reference Firestore collections for signaling
    const callDoc = doc(collection(this.db, this.collectionName));
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    const callId = callDoc.id;
    
    // Get candidates for caller, save to db
    this.rtc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };
  
    // Create offer
    const offerDescription = await this.rtc.createOffer();
    await this.rtc.setLocalDescription(offerDescription);
  
    const offerObj = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };
    const callObj={
      type:config.enableVideo?'video':'audio',
      offer:offerObj,
      status:'started',
      createdTime:new Date(),
    }
    await setDoc(callDoc,  callObj );
    
    // Listen for remote answer
    onSnapshot(callDoc,(snapshot) => {
      const data = snapshot.data();
      if (!this.rtc.currentRemoteDescription && data?.answer) {
        console.log('Get answer',data);
        const answerDescription = new RTCSessionDescription(data.answer);
        this.rtc.setRemoteDescription(answerDescription);
      }
      if(data.status==='ended'){
        endFun();
      }
    });
    // When answered, add candidate to peer connection
    onSnapshot(answerCandidates,(snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            this.rtc.addIceCandidate(candidate);
        }
      });
    });
    
    
    callback();
    return callId;
  };
  answer = async (callId,callback) => {
    const callDoc = doc(this.db, this.collectionName, callId);
    if(!callDoc || callDoc.id!=callId){
      return false;
    }
    const callData = (await getDoc(callDoc)).data();
    if(!callData || callData.status!=='started'){
      return false;
    }
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    
    this.rtc.onicecandidate = (event) => {
      event.candidate  && addDoc(answerCandidates, event.candidate.toJSON());
    };
   
    
  
    const offerDescription = callData.offer;
    await this.rtc.setRemoteDescription(new RTCSessionDescription(offerDescription));
  
    const answerDescription = await this.rtc.createAnswer();
    await this.rtc.setLocalDescription(answerDescription);
  
    const answerObj = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };
    const callObj={
      answer:answerObj,
      status:'answered',
      answerTime: new Date(),
    }
    await updateDoc(callDoc, callObj);
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            let data = change.doc.data();
            this.rtc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
    onSnapshot(callDoc,(snapshot) => {
      const data = snapshot.data();
      if(data.status==='ended'){
        endFun();
      }
    });
    if(config.answerCallback)
      config.answerCallback();
    if(callback)
      callback();
    return true;
  };
  switchCam=async()=>{
    if (config.localStream) {
      const currentVideoTrack = config.localStream.getVideoTracks()[0];
      const videoDevices = await navigator.mediaDevices.enumerateDevices()
        .then(devices => devices.filter(device => device.kind === 'videoinput'));
      const currentDevice = videoDevices.find(device => device.deviceId === currentVideoTrack.getSettings().deviceId);
      const nextDeviceIndex = (videoDevices.indexOf(currentDevice) + 1) % videoDevices.length;
      const nextDevice = videoDevices[nextDeviceIndex];
      
      const newVideoStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: nextDevice.deviceId } });
      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      config.localStream.removeTrack(currentVideoTrack);
      config.localStream.addTrack(newVideoTrack);
      if(callback)
        callback(config.localStream);
  
      this.rtc.getSenders().find(sender => sender.track.kind === 'video').replaceTrack(newVideoTrack);
      currentVideoTrack.stop();
    }
    
  };
  switchAudioInput=async()=>{
    if (audioInputDevices.length === 0) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputDevices = devices.filter(device => device.kind === 'audioinput');
    }
    if (audioInputDevices.length > 1) {
      currentAudioInputIndex = (currentAudioInputIndex + 1) % audioInputDevices.length;
      const nextAudioDeviceId = audioInputDevices[currentAudioInputIndex].deviceId;
  
      const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: nextAudioDeviceId } });
      const newAudioTrack = newAudioStream.getAudioTracks()[0];
  
      const oldAudioTrack = config.localStream.getAudioTracks()[0];
      if (oldAudioTrack) {
        config.localStream.removeTrack(oldAudioTrack);
      oldAudioTrack.stop();
      }
      
      config.localStream.addTrack(newAudioTrack);
      
      // Replace the audio track in the peer connection
      const sender = this.rtc.getSenders().find(sender => sender.track.kind === 'audio');
      if (sender) {
      sender.replaceTrack(newAudioTrack);
      }
    }
  };
  switchAudioOutput = async()=>{
    if (audioOutputDevices.length === 0) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
    }
  
    if (audioOutputDevices.length > 1) {
      currentAudioOutputIndex = (currentAudioOutputIndex + 1) % audioOutputDevices.length;
      const nextAudioDeviceId = audioOutputDevices[currentAudioOutputIndex].deviceId;
  
      if (typeof remoteVideo.setSinkId === 'undefined') {
        console.warn('Audio output switching is not supported by your browser.');
        return;
      }
  
      try {
        await remoteVideo.setSinkId(nextAudioDeviceId);
        console.log(`Switched to audio device: ${nextAudioDeviceId}`);
      } catch (error) {
        console.error(`Error switching audio output device: ${error}`);
      }
    }
  }
}