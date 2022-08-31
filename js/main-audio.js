
import {init,start,answer,end,mute} from './call.js'


// HTML elements
const webcamVideo = document.getElementById('webcamVideo');
const remoteVideo = document.getElementById('remoteVideo');
const muteAudioButton = document.getElementById('muteAudio');
const muteVideoButton = document.getElementById('muteVideo');

const muteAudioIcon = document.getElementById('muteAudioIcon');
const muteVideoIcon = document.getElementById('muteVideoIcon');

const hangupButton = document.getElementById('hangupButton');
const shareButton = document.getElementById('shareButton');
const copyButton = document.getElementById('copyButton');

shareButton.style.display='none';
   copyButton.style.display='none';
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
 callId=await start(()=>{
   console.log('Call Started');
   shareButton.style.display='inline-block';
   copyButton.style.display='inline-block';
 });
 console.log("Id=",callId);
}
shareButton.onclick=()=>{
 const url= window.location.origin+'/video.html?call-id='+callId;
 window.open('whatsapp://send?text='+url); 
}
copyButton.onclick=async()=>{
   const url= window.location.origin+'/video.html?call-id='+callId;
   await navigator.clipboard.writeText(url); 
   alert('تم نسخ الرابط');
 }

 hangupButton.onclick=async ()=>{ await end(callId,()=>{
   window.location.href= window.location.origin+'/thank.html';
 });};
window.addEventListener('beforeunload', ()=>{
 hangupButton.click();
});
muteAudioButton.onclick=()=>
{ 
   mute(true,(active)=>{
       if(active)
       {
         muteAudioIcon.className='fas fa-microphone';
         muteAudioButton.className='btn_option active';    
       }else
       {
         muteAudioIcon.className='fas fa-microphone-slash';
         muteAudioButton.className='btn_option';
       }
   });
};
muteVideoButton.onclick=()=>{ 
   mute(false,(active)=>{
       if(active)
       {
         muteVideoIcon.className='fas fa-video';
         muteVideoButton.className='btn_option active';  
       }else
       {
           muteVideoIcon.className='fas fa-video-slash';
           muteVideoButton.className='btn_option';
       }
   });
};
