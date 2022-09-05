import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  onSnapshot,
} from "firebase/firestore";
export const config = {
  iceServersUrls: [],
  firebaseConfig: {},
  hasVideo: true,
};
let rtcServers = {
  iceServers: [
    {
      urls: [],
    },
  ],
  iceCandidatePoolSize: 10,
};
let endFun;
let variables = {};
let callEnded = false;
export default class WebRTC {
  collectionName;
  db;
  rtc;
  openVideo;
  openAudio;
  constructor(config) {
    this.collectionName = "calls";
    this.db = getFirestore(initializeApp(config.firebaseConfig));
    this.rtc = null;
    rtcServers.iceServers.urls = config.iceServersUrls;
    variables.enableVideo = isVideo;
    this.openVideo = true;
    this.openAudio = true;
  }
  end = async (callId, callback) => {
    if (callEnded) {
      return;
    } else {
      callEnded = true;
    }
    if (variables.localStream) {
      variables.localStream.getTracks().forEach((track) => track.stop());
    }
    if (variables.remoteStream) {
      variables.remoteStream.getTracks().forEach((track) => track.stop());
    }

    if (this.rtc) {
      this.rtc.close();
    }
    if (callId) {
      const callDoc = doc(this.db, this.collectionName, callId);
      const callObj = {
        status: "ended",
        endTime: new Date(),
      };
      await updateDoc(callDoc, callObj);
    }
    if (callback) callback();
  };
  mute = (isAudio, callback) => {
    let active = false;
    if (isAudio) {
      variables.localStream.getAudioTracks().forEach((track) => {
        this.openAudio = !this.openAudio;
        active = this.openAudio;
        track.enabled = this.openAudio;
      });
    } else {
      variables.localStream.getVideoTracks().forEach((track) => {
        this.openVideo = !this.openVideo;
        active = this.openVideo;
        track.enabled = this.openVideo;
      });
    }
    if (callback) callback(active);
  };
  init = async (callback, answerCallback) => {
    this.rtc = new RTCPeerConnection(rtcServers);
    variables.answerCallback = answerCallback;
    variables.localStream = await navigator.mediaDevices.getUserMedia({
      video: variables.enableVideo,
      audio: true,
    });
    variables.remoteStream = new MediaStream();

    // Push tracks from local stream to peer connection
    variables.localStream.getTracks().forEach((track) => {
      this.rtc.addTrack(track, variables.localStream);
    });

    // Pull tracks from remote stream, add to video stream
    this.rtc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        variables.remoteStream.addTrack(track);
      });
      if (variables.answerCallback) variables.answerCallback();
    };
    callback(variables.localStream, variables.remoteStream);
    endFun = this.end;
  };
  start = async (callback) => {
    // Reference Firestore collections for signaling
    const callDoc = doc(collection(this.db, this.collectionName));
    const answerCandidates = collection(callDoc, "answerCandidates");
    const offerCandidates = collection(callDoc, "offerCandidates");
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
    const callObj = {
      type: variables.enableVideo ? "video" : "audio",
      offer: offerObj,
      status: "started",
      createdTime: new Date(),
    };
    await setDoc(callDoc, callObj);

    // Listen for remote answer
    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (!this.rtc.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        this.rtc.setRemoteDescription(answerDescription);
      }
      if (data.status === "ended") {
        endFun();
      }
    });
    // When answered, add candidate to peer connection
    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const candidate = new RTCIceCandidate(change.doc.data());
          this.rtc.addIceCandidate(candidate);
        }
      });
    });

    callback();
    return callId;
  };
  answer = async (callId, callback) => {
    const callDoc = doc(this.db, this.collectionName, callId);
    if (!callDoc || callDoc.id != callId) {
      return false;
    }
    const callData = (await getDoc(callDoc)).data();
    if (!callData || callData.status !== "started") {
      return false;
    }
    const answerCandidates = collection(callDoc, "answerCandidates");
    const offerCandidates = collection(callDoc, "offerCandidates");

    this.rtc.onicecandidate = (event) => {
      event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
    };

    const offerDescription = callData.offer;
    await this.rtc.setRemoteDescription(
      new RTCSessionDescription(offerDescription)
    );

    const answerDescription = await this.rtc.createAnswer();
    await this.rtc.setLocalDescription(answerDescription);

    const answerObj = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };
    const callObj = {
      answer: answerObj,
      status: "answered",
      answerTime: new Date(),
    };
    await updateDoc(callDoc, callObj);
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          let data = change.doc.data();
          this.rtc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (data.status === "ended") {
        endFun();
      }
    });
    if (variables.answerCallback) variables.answerCallback();
    if (callback) callback();
    return true;
  };
}
