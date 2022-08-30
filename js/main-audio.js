
import { config } from './config.js';
import {init,start,answer,end,mute} from './call.js'


 // HTML elements
const webcamVideo = document.getElementById('webcamVideo');
const remoteVideo = document.getElementById('remoteVideo');
const muteAudioButton = document.getElementById('muteAudio');

const muteAudioIcon = document.getElementById('muteAudioIcon');

const hangupButton = document.getElementById('hangupButton');
const shareButton = document.getElementById('shareButton');
const copyButton = document.getElementById('copyButton');
const speakerButton = document.getElementById('speaker');


// 1. Setup media sources
await init(false,(localStream,remoteStream)=>{
  console.log('Call initiated');
  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;
},()=>{shareButton.remove();copyButton.remove();});
console.log('Getting call Id...');
const urlParams = new URLSearchParams(window.location.search);
let callId = urlParams.get('call-id');
if(callId){
  console.log('Call Id is:',callId);
  await answer(callId,()=>{
    console.log('Call Answered:',callId);
  });
}else{
  console.log('This is new call');
  callId=await start(()=>console.log('Call Started'));
  console.log("Id=",callId);
}
shareButton.onclick=()=>{
  const url= window.location.origin+'/audio.html?call-id='+callId;
  window.open('whatsapp://send?text='+url); 
}

copyButton.onclick=async()=>{
    const url= window.location.origin+'/audio.html?call-id='+callId;
    await navigator.clipboard.writeText(url); 
    alert('تم نسخ الرابط');
  }
  window.addEventListener('beforeunload', ()=>{
    hangupButton.click();
  });
hangupButton.onclick=async ()=>{ await end(callId,false,()=>{
  window.location.href= window.location.origin+'/thank.html';
});};
muteAudioButton.onclick=()=>
{ 
    mute(true,(active)=>{
        if(active)
        {
            muteAudioIcon.className='fas fa-microphone-slash';
            muteAudioButton.className='btn_option';
        }else
        {
        muteAudioIcon.className='fas fa-microphone';
        muteAudioButton.className='btn_option active';  
        }
    });
};  
speakerButton.onclick = async ()=>{
  let i=0;
  if(speakerButton.className.indexOf('active')==-1)
  {
    i=1;
    speakerButton.className='active';
  }
  else{
    speakerButton.className='';
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  
  const outAudioDevices = devices.filter(device => device.kind === 'audiooutput');
  const audioDevices = devices.filter(device => device.kind === 'audioinput');
  if (!audioDevices[i] || !outAudioDevices[i]){
   console.log('No devices');
    return;
  }
  const outDeviceId=outAudioDevices[2].deviceId;
  const deviceId = audioDevices[i].deviceId;
  config.localStream.getAudioTracks().forEach((track) => {
    track.stop();
  });
  // config.remoteStream.getAudioTracks().forEach((track) => {
  //   track.stop();
  // });
  
  const constraints = {
    audio: {deviceId: {exact: deviceId}}
  }; 
  console.log(outAudioDevices[i]);
  await remoteVideo.setSinkId(outDeviceId).catch(handleError);
  navigator.mediaDevices.getUserMedia(constraints).then(gotStream).catch(handleError);
  
}


function gotStream(stream) {
  // Refresh button list in case labels have become available
  return navigator.mediaDevices.enumerateDevices();
}
function handleError(error) {

  console.log('navigator.MediaDevices.getUserMedia error: ', error);

}