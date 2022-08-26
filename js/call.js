import  './firebase-app.js';
import  './firebase.firestore.js';

import { config } from './config.js';
if (!firebase.apps.length) {
  firebase.initializeApp(config.firebase);
}
const app=firebase.firestore();
let rtc=null;
export const mute=(isAudio,callback)=>{
    let active=false;
    if(isAudio){
        config.localStream.getAudioTracks().forEach((track) => {
            track.enabled =config.enableAudio;
            active=config.enableAudio=!config.enableAudio;
        });
    }else{
        config.localStream.getVideoTracks().forEach((track) => {
            track.enabled =config.enableVideo;
            active=config.enableVideo=!config.enableVideo;
        });
    }
    if(callback)
      callback(active);
}

export const init = async (callback,answerCallback) => {
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
    const callDoc = app.collection('calls').doc();
    const offerCandidates = callDoc.collection('offerCandidates');
    const answerCandidates = callDoc.collection('answerCandidates');
    const endedCalls = callDoc.collection('endCall');
    const callId = callDoc.id;
    
    // Get candidates for caller, save to db
    rtc.onicecandidate = (event) => {
      event.candidate && offerCandidates.add(event.candidate.toJSON());
    };
  
    // Create offer
    const offerDescription = await rtc.createOffer();
    await rtc.setLocalDescription(offerDescription);
  
    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };
  
    await callDoc.set({ offer });
  
    // Listen for remote answer
    callDoc.onSnapshot((snapshot) => {
      const data = snapshot.data();
      if (!rtc.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        rtc.setRemoteDescription(answerDescription);
      }
    });
  
    // When answered, add candidate to peer connection
    answerCandidates.onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            rtc.addIceCandidate(candidate);
        }else{
            console.log('alaa',change.type);
        }
      });
    });

    endedCalls.onSnapshot((snapshot) => {
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
    const callDoc = app.collection('calls').doc(callId);
    const answerCandidates = callDoc.collection('answerCandidates');
    const offerCandidates = callDoc.collection('offerCandidates');
    const endedCalls = callDoc.collection('endCall');
    rtc.onicecandidate = (event) => {
      event.candidate && answerCandidates.add(event.candidate.toJSON());
    };
    endedCalls.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
              const id=change.doc.data().id;
              console.log('ended',id);
              end(id,true);
          }
        });
    });
    const callData = (await callDoc.get()).data();
  
    const offerDescription = callData.offer;
    await rtc.setRemoteDescription(new RTCSessionDescription(offerDescription));
  
    const answerDescription = await rtc.createAnswer();
    await rtc.setLocalDescription(answerDescription);
  
    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };
  
    await callDoc.update({ answer });
  
    offerCandidates.onSnapshot((snapshot) => {
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
export const end =(callId,fromSnapshow,callback) => {
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
    
        
            const callDoc = app.collection('calls').doc(callId);
            if(callDoc)
            {
                const endedCalls = callDoc.collection('endCall');
                if(endedCalls)
                {
                    endedCalls.add({id:callId});
                } 
            }
    }
  if(callback)
    callback();
  else
      window.location.href= window.location.origin+'/thank.html';
    
}



