import WebRTC from  './call.js'
let webRTCObject;
let callId='';
let pageName='audio';
export default class MakeCall{
  pageName;
  callId;
  webRTC;
  constructor(hasVideo){
    this.pageName='audio';
    this.callId ='';
    this.webRTC=new WebRTC(hasVideo);
    if(hasVideo)
      this.pageName='video';
    shareButton.style.display='none';
    copyButton.style.display='none'; 
  }
  start = async()=>{
    await this.webRTC.init((localStream,remoteStream)=>{
      console.log('Call initiated');
      webcamVideo.srcObject = localStream;
      remoteVideo.srcObject = remoteStream;
    },()=>{shareButton.remove();copyButton.remove();});
    console.log('Getting call Id...');
    const urlParams = new URLSearchParams(window.location.search);
    this.callId = urlParams.get('call-id');
    if(this.callId){
      console.log('Call Id is:',this.callId);
      var answerResult =await this.webRTC.answer(this.callId,()=>{
        console.log('Call Answered:',this.callId);
      });
      if(!answerResult){
        alert('مكالمة مغلقة');
        window.location.href= window.location.origin+'/thank.html';
      }
    }else{
      console.log('This is new call');
      this.callId=await this.webRTC.start(()=>{
        console.log('Call Started');
        shareButton.style.display='inline-block';
        copyButton.style.display='inline-block';
      });
      console.log("Id=",this.callId);
    }
    callId=this.callId;
    webRTCObject=this.webRTC;
    pageName=this.pageName;
  }
}
  
 // HTML elements
const webcamVideo = document.getElementById('webcamVideo');
const remoteVideo = document.getElementById('remoteVideo');
const muteAudioButton = document.getElementById('muteAudio');
const muteVideoButton = document.getElementById('muteVideo');
const switchCameraButton = document.getElementById('switchCamera');
const switchAudioInputButton = document.getElementById('switchAudioInput');
const switchAudioOutputButton = document.getElementById('switchAudioOutput');

const muteAudioIcon = document.getElementById('muteAudioIcon');
const muteVideoIcon = document.getElementById('muteVideoIcon');

const hangupButton = document.getElementById('hangupButton');
const shareButton = document.getElementById('shareButton');
const copyButton = document.getElementById('copyButton');

 
switchCameraButton.onclick=()=>{ 
  webRTCObject.switchCam((newLocalStream)=>{
    if(newLocalStream)
    webcamVideo.srcObject = newLocalStream;
  });
};

switchAudioInputButton.onclick=()=>{ 
  webRTCObject.switchAudioInput();
};
switchAudioOutputButton.onclick=()=>{ 
  webRTCObject.switchAudioOutput();
};

shareButton.onclick=()=>{
  const url= window.location.origin+'/'+pageName+'.html?call-id='+callId;
  window.open('whatsapp://send?text='+url); 
}
copyButton.onclick=async()=>{
    const url= window.location.origin+'/'+pageName+'.html?call-id='+callId;
    await navigator.clipboard.writeText(url); 
    alert('تم نسخ الرابط');
  }

  hangupButton.onclick=async ()=>{ await webRTCObject.end(callId,()=>{
    window.location.href= window.location.origin+'/thank.html';
  });};
window.addEventListener('beforeunload', ()=>{
  hangupButton.click();
});
muteAudioButton.onclick=()=>
{ 
  webRTCObject.mute(true,(active)=>{
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
  webRTCObject.mute(false,(active)=>{
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
}