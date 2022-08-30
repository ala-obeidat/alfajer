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
const db=getFirestore(app);
let rtc=null;
export const mute=(isAudio,callback)=>{
    let active=false;
    if(isAudio){
        config.localStream.getAudioTracks().forEach((track) => {
          active=config.enableAudio=!config.enableAudio;  
          track.enabled =config.enableAudio;
            
        });
    }else{
        config.localStream.getVideoTracks().forEach((track) => {
            
            active=config.enableVideo=!config.enableVideo;
            track.enabled =config.enableVideo;
        });
    }
    if(callback)
      callback(active);
}

export const init = async (enableVideo,callback,answerCallback) => {
  config.enableVideo=enableVideo;
  rtc= new RTCPeerConnection(config.rtc);
    config.answerCallback=answerCallback;
    config.localStream = await navigator.mediaDevices.getUserMedia({ video: config.enableVideo, audio: config.enableAudio });
    config.remoteStream = new MediaStream();
  
    // Push tracks from local stream to peer connection
    config.localStream.getTracks().forEach((track) => {
      rtc.addTrack(track, config.localStream);
    });
    
    // Pull tracks from remote stream, add to video stream
    rtc.ontrack = (event) => {
      event.streams[0].getAudioTracks().forEach((track) => {
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
    const callDoc = doc(collection(db, config.collectionName));
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    const endedCalls = collection(callDoc,'endCall');
    const callId = callDoc.id;
    
    // Get candidates for caller, save to db
    rtc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };
  
    // Create offer
    const offerDescription = await rtc.createOffer();
    await rtc.setLocalDescription(offerDescription);
  
    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };
    await setDoc(callDoc, { offer });
  
    // Listen for remote answer
    onSnapshot(callDoc,(snapshot) => {
      const data = snapshot.data();
      if (!rtc.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        rtc.setRemoteDescription(answerDescription);
      }
    });
    // When answered, add candidate to peer connection
    onSnapshot(answerCandidates,(snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            rtc.addIceCandidate(candidate);
        }else{
            console.log('alaa',change.type);
        }
      });
    });
    onSnapshot(endedCalls,(snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
              const id=change.doc.data().id;
              console.log('ended',id);
               end(id,true);
          }
        });
    });
    
    callback();
    return callId;
};
  
// 3. Answer the call with the unique ID
export const answer = async (callId,callback) => {
    const callDoc = doc(db, config.collectionName, callId);
    const answerCandidates = collection(callDoc,'answerCandidates');
    const offerCandidates = collection(callDoc,'offerCandidates');
    const endedCalls = collection(callDoc,'endCall');
    rtc.onicecandidate = (event) => {
      event.candidate  && addDoc(answerCandidates, event.candidate.toJSON());
    };
    onSnapshot(endedCalls,(snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
              const id=change.doc.data().id;
              console.log('ended',id);
              end(id,true);
          }
        });
    });
    const callData = (await getDoc(callDoc)).data();
  
    const offerDescription = callData.offer;
    await rtc.setRemoteDescription(new RTCSessionDescription(offerDescription));
  
    const answerDescription = await rtc.createAnswer();
    await rtc.setLocalDescription(answerDescription);
  
    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };
  
    await updateDoc(callDoc, { answer });
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            let data = change.doc.data();
            rtc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
    if(config.answerCallback)
      config.answerCallback();
    if(callback)
      callback();
};

// 4. Hangup
export const end =async (callId,fromSnapshow,callback) => {
    console.log('Ending the call..',callId); 
    if(!fromSnapshow)
    {
        if(config.localStream){
        config.localStream.getTracks().forEach(track => track.stop());
        }
        if(config.remoteStream){
            config.remoteStream.getTracks().forEach(track => track.stop())
        }
    
        if(rtc){
            rtc.close();
        }
    
        
        const callDoc = doc(db, config.collectionName, callId);
        await deleteDoc(callDoc);
    }
  if(callback)
    callback();
  else
      window.location.href= window.location.origin+'/thank.html';
    
}