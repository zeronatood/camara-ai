(() => {
  class CameraAdapter {
    async open() { throw new Error('Camera adapter must implement open()'); }
    async close() { throw new Error('Camera adapter must implement close()'); }
    async listDevices() { return []; }
    get stream() { return null; }
  }
  class WebcamAdapter extends CameraAdapter {
    constructor(videoElement) { super(); this.videoElement=videoElement; this._stream=null; }
    async listDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      return (await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');
    }
    async open(deviceId='') {
      await this.close();
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('เบราว์เซอร์ไม่รองรับการเปิดกล้อง'),{name:'NotSupportedError'});
      this._stream=await navigator.mediaDevices.getUserMedia({video:deviceId?{deviceId:{exact:deviceId}}:{facingMode:'user'},audio:false});
      this.videoElement.srcObject=this._stream;
      await this.videoElement.play();
      return this._stream;
    }
    async close() {
      if (this._stream) this._stream.getTracks().forEach(track=>track.stop());
      this._stream=null;
      if(this.videoElement)this.videoElement.srcObject=null;
    }
    get stream() { return this._stream; }
  }
  // CCTV/RTSP sources must be proxied by a trusted server-side adapter; browsers cannot safely read RTSP streams directly.
  class CctvAdapter extends CameraAdapter {
    constructor(sourceId) { super(); this.sourceId=sourceId; }
    async open() { throw new Error('CCTV adapter needs a server-side RTSP/ONVIF gateway'); }
    async close() { return true; }
  }
  window.CameraAdapters={CameraAdapter,WebcamAdapter,CctvAdapter};
})();
