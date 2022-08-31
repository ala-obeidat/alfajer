import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.9.3/firebase-app.js';
import { getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot } from 'https://www.gstatic.com/firebasejs/9.9.3/firebase-firestore.js'

import { config } from './config.js';
const app=initializeApp(config.firebase);
const collectionName='calls';
const db=getFirestore(app);
let rtc=null;
export const initStream=(isVideo)=>{
  config.enableVideo=isVideo;
}
let openVideo=true;
let openAudio=true;
export const mute=(isAudio,callback)=>{
    let active=false;
    if(isAudio){
        config.localStream.getAudioTracks().forEach((track) => {
          openAudio=!openAudio;
          active=openAudio;  
          track.enabled =openAudio;
        });
    }else{
        config.localStream.getVideoTracks().forEach((track) => {
          openVideo=!openVideo;
          active=openVideo;  
          track.enabled =openVideo;
        });
    }
    if(callback)
      callback(active);
}

export const init = async (callback,answerCallback) => {
    rtc= new RTCPeerConnection(config.rtc);
    config.answerCallback=answerCallback;
    config.localStream = await navigator.mediaDevices.getUserMedia({ video: config.enableVideo, audio: true });
    config.remoteStream = new MediaStream();
  
    // Push tracks from local stream to peer connection
    config.localStream.getTracks().forEach((track) => {
      rtc.addTrack(track, config.localStream);
    });
    
    // Pull tracks from remote stream, add to video stream
    rtc.ontrack = (event) => { 
      event.streams[0].getTracks().forEach((track) => {
        config.remoteStream.addTrack(track);
      });
      if(config.answerCallback)
        config.answerCallback();
    };
    callback(config.localStream,config.remoteStream);
};

// 2. Create an offer
export const start = async (callback) => {
    // Reference Firestore collections for signaling
    const callDoc = doc(collection(db, collectionName));
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    const callId = callDoc.id;
    
    // Get candidates for caller, save to db
    rtc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };
  
    // Create offer
    const offerDescription = await rtc.createOffer();
    await rtc.setLocalDescription(offerDescription);
  
    const offerObj = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };
    const callObj={
      type:config.enableVideo?'video':'audio',
      offer:offerObj,
      status:'started',
      createdTime:getCurrentDate(),
    }
    await setDoc(callDoc,  callObj );
    
    // Listen for remote answer
    onSnapshot(callDoc,(snapshot) => {
      const data = snapshot.data();
      if (!rtc.currentRemoteDescription && data?.answer) {
        console.log('Get answer',data);
        const answerDescription = new RTCSessionDescription(data.answer);
        rtc.setRemoteDescription(answerDescription);
      }
      if(data.status==='ended'){
        end();
      }
    });
    // When answered, add candidate to peer connection
    onSnapshot(answerCandidates,(snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            rtc.addIceCandidate(candidate);
        }
      });
    });
    
    
    callback();
    return callId;
};
  
// 3. Answer the call with the unique ID
export const answer = async (callId,callback) => {
    const callDoc = doc(db, collectionName, callId);
    if(!callDoc || callDoc.id!=callId){
      return false;
    }
    const callData = (await getDoc(callDoc)).data();
    if(!callData || callData.status!=='started'){
      return false;
    }
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    
    rtc.onicecandidate = (event) => {
      event.candidate  && addDoc(answerCandidates, event.candidate.toJSON());
    };
   
    
  
    const offerDescription = callData.offer;
    await rtc.setRemoteDescription(new RTCSessionDescription(offerDescription));
  
    const answerDescription = await rtc.createAnswer();
    await rtc.setLocalDescription(answerDescription);
  
    const answerObj = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };
    const callObj={
      answer:answerObj,
      status:'answered',
      answerTime: getCurrentDate(),
    }
    await updateDoc(callDoc, callObj);
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            let data = change.doc.data();
            rtc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
    onSnapshot(callDoc,(snapshot) => {
      const data = snapshot.data();
      if(data.status==='ended'){
        end();
      }
    });
    if(config.answerCallback)
      config.answerCallback();
    if(callback)
      callback();
    return true;
};

// 4. Hangup
export const end =async (callId) => {
    console.log('Ending the call..',callId); 
    
    if(config.localStream){
      config.localStream.getTracks().forEach(track => track.stop());
    }
    if(config.remoteStream){
      config.remoteStream.getTracks().forEach(track => track.stop())
    }
    
        if(rtc){
            rtc.close();
        }
        if(callId)
        {
          const callDoc = doc(db, collectionName, callId);
          const callObj={
            status:'ended',
            endTime:getCurrentDate()
          }
          await updateDoc(callDoc,  callObj );
        }
      window.location.href= window.location.origin+'/thank.html';
    
}
const getCurrentDate=()=>{
  const date=new Date;
  return date;
}