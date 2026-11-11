(() => {
  const video = document.getElementById('cameraVideo');
  const cameraAdapter = new window.CameraAdapters.WebcamAdapter(video);
  const stage = document.getElementById('cameraStage');
  const placeholder = document.getElementById('cameraPlaceholder');
  const message = document.getElementById('cameraMessage');
  const help = document.getElementById('cameraHelp');
  const select = document.getElementById('cameraSelect');
  const startButton = document.getElementById('startCamera');
  const stopButton = document.getElementById('stopCamera');
  const connection = document.getElementById('connection');
  const connectionText = document.getElementById('connectionText');
  const toast = document.getElementById('toast');
  let stream = null;
  let toastTimer;
  let detectTimer = null;
  const guideStatus = document.getElementById('faceDetectStatus');
  const verifyButton = document.getElementById('verifyFace');
  const reviewPanel = document.getElementById('faceReview');
  const detectedFaceBox = document.getElementById('detectedFaceBox');

  function showDetectedFace(face) {
    if (!face || !video.videoWidth || !video.videoHeight) { detectedFaceBox.hidden = true; return; }
    const box = Array.isArray(face.box) ? { x: face.box[0], y: face.box[1], width: face.box[2], height: face.box[3] } : face.box;
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) { detectedFaceBox.hidden = true; return; }
    const sx = stage.clientWidth / video.videoWidth;
    const sy = stage.clientHeight / video.videoHeight;
    const scale = Math.max(sx, sy); // camera preview uses object-fit: cover
    const offsetX = (stage.clientWidth - video.videoWidth * scale) / 2;
    const offsetY = (stage.clientHeight - video.videoHeight * scale) / 2;
    detectedFaceBox.style.left = `${stage.clientWidth - (offsetX + (box.x + box.width) * scale)}px`;
    detectedFaceBox.style.top = `${offsetY + box.y * scale}px`;
    detectedFaceBox.style.width = `${box.width * scale}px`;
    detectedFaceBox.style.height = `${box.height * scale}px`;
    detectedFaceBox.hidden = false;
  }

  function notify(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function setStatus(connected, statusText) {
    connection.classList.toggle('connected', connected);
    connectionText.textContent = statusText;
  }

  function stopCamera() {
    clearTimeout(detectTimer);
    detectTimer = null;
    cameraAdapter.close();
    stream = null;
    video.srcObject = null;
    stage.classList.remove('is-live');
    startButton.disabled = false;
    stopButton.disabled = true;
    select.disabled = false;
    setStatus(false, 'ยังไม่เชื่อมต่อ');
    message.textContent = 'กล้องยังไม่ทำงาน';
    help.textContent = 'กดปุ่มด้านล่างเพื่อเลือกและเปิดกล้อง';
    stage.classList.remove('face-ready');
    detectedFaceBox.hidden = true;
    guideStatus.textContent = 'จัดใบหน้าให้อยู่ในกรอบ';
    verifyButton.disabled = true;
  }

  async function populateCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(device => device.kind === 'videoinput');
      const previous = select.value;
      select.replaceChildren();
      cameras.forEach((camera, index) => {
        const option = document.createElement('option');
        option.value = camera.deviceId;
        option.textContent = camera.label || `กล้อง ${index + 1}`;
        select.append(option);
      });
      if (previous && cameras.some(camera => camera.deviceId === previous)) select.value = previous;
      if (cameras.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'ไม่พบกล้อง';
        select.append(option);
      }
      select.disabled = cameras.length === 0 || Boolean(stream);
    } catch {
      notify('ไม่สามารถอ่านรายการกล้องได้ กรุณาตรวจสอบสิทธิ์ของเบราว์เซอร์');
    }
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      message.textContent = 'เบราว์เซอร์นี้เปิดกล้องไม่ได้';
      help.textContent = 'เปิดหน้านี้ผ่าน localhost หรือ HTTPS แล้วลองอีกครั้ง';
      setStatus(false, 'เบราว์เซอร์ไม่รองรับ');
      notify('กล้องต้องใช้เบราว์เซอร์ที่รองรับและหน้าเว็บผ่าน localhost หรือ HTTPS');
      return;
    }
    startButton.disabled = true;
    message.textContent = 'กำลังเชื่อมต่อกล้อง…';
    help.textContent = 'โปรดอนุญาตการใช้กล้องเมื่อเบราว์เซอร์ถาม';
    try {
      stream = await cameraAdapter.open(select.value);
      stage.classList.add('is-live');
      verifyButton.disabled = false;
      reviewPanel.hidden = true;
      stopButton.disabled = false;
      setStatus(true, 'เชื่อมต่อแล้ว');
      await populateCameras();
      select.disabled = true;
      notify('เชื่อมต่อกล้องแล้ว · ภาพไม่ถูกบันทึก');
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        stopCamera();
        notify('กล้องหยุดทำงานหรือถูกตัดการเชื่อมต่อ');
      }, { once: true }));
      runFaceDetection();
    } catch (error) {
      stream = null;
      startButton.disabled = false;
      setStatus(false, 'เชื่อมต่อไม่สำเร็จ');
      message.textContent = 'ไม่สามารถเปิดกล้องได้';
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        help.textContent = 'กรุณาอนุญาตสิทธิ์กล้องในการตั้งค่าเบราว์เซอร์';
        notify('ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณาอนุญาตสิทธิ์แล้วลองใหม่');
      } else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        help.textContent = 'ไม่พบกล้องที่เลือก กรุณาเลือกอุปกรณ์อื่น';
        notify('ไม่พบกล้องที่เลือก ตรวจสอบการเชื่อมต่อแล้วลองใหม่');
        await populateCameras();
      } else if (error.name === 'NotReadableError' || error.name === 'AbortError') {
        help.textContent = 'กล้องอาจกำลังถูกใช้งานโดยโปรแกรมอื่น';
        notify('กล้องไม่พร้อมใช้งาน ปิดแอปอื่นที่กำลังใช้กล้องแล้วลองใหม่');
      } else {
        help.textContent = 'ตรวจสอบการเชื่อมต่อกล้องและลองอีกครั้ง';
        notify('เกิดข้อผิดพลาดในการเปิดกล้อง กรุณาลองอีกครั้ง');
      }
    }
  }

  async function runFaceDetection() {
    if (!stream) return;
    try {
      const result = await FaceEngine.detect(video);
      const faces = Array.isArray(result.face) ? result.face : [];
      showDetectedFace(faces.length === 1 ? faces[0] : null);
      stage.classList.toggle('face-ready', faces.length === 1 && (faces[0].score ?? 1) >= .8);
      guideStatus.textContent = faces.length === 0 ? 'ไม่พบใบหน้า · จัดใบหน้าให้อยู่ในกรอบ' : faces.length > 1 ? 'พบหลายใบหน้า · ให้เหลือหนึ่งคนในภาพ' : 'พบใบหน้า · กดตรวจสอบเพื่อยืนยันตัวตน';
    } catch {
      showDetectedFace(null);
      guideStatus.textContent = 'กำลังเตรียมระบบตรวจจับใบหน้า…';
    }
    if (stream) detectTimer = setTimeout(runFaceDetection, 700);
  }

  async function verifySource(source) {
    verifyButton.disabled = true;
    reviewPanel.hidden = false;
    reviewPanel.textContent = 'กำลังตรวจสอบใบหน้าในอุปกรณ์นี้…';
    try {
      const inspected = await FaceEngine.inspect(source);
      if (!inspected.ok) throw new Error(inspected.reason);
      const result = await FA.api('/api/face/verify', { method: 'POST', body: JSON.stringify({ embedding: inspected.embedding }) });
      reviewPanel.replaceChildren();
      const title = document.createElement('b');
      const detail = document.createElement('span');
      title.textContent = result.status === 'teacher_review' ? `ยืนยันผู้เรียน: ${result.candidate.firstName} ${result.candidate.lastName} (${result.candidate.studentCode})` : 'ยังยืนยันตัวตนไม่ได้';
      detail.textContent = result.message;
      reviewPanel.append(title, detail);
      if (result.status === 'teacher_review') {
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'primary-button'; confirm.textContent = 'ครูยืนยันและบันทึกเวลา';
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          try { await FA.api('/api/face/confirm', { method: 'POST', body: JSON.stringify({ reviewToken: result.reviewToken }) }); detail.textContent = 'บันทึกเวลาแล้ว'; confirm.remove(); window.dispatchEvent(new CustomEvent('fa:refresh')); notify('ยืนยันและบันทึกเวลาเข้าเรียนแล้ว'); }
          catch (error) { detail.textContent = error.message; confirm.disabled = false; }
        });
        reviewPanel.append(confirm);
      } else {
        detail.textContent += ' · ใช้วิธีเช็กชื่อสำรองและให้ครูตรวจสอบ';
      }
    } catch (error) {
      reviewPanel.textContent = `${error.message} · ไม่มีการบันทึกเวลา`;
    } finally { verifyButton.disabled = !stream; }
  }
  verifyButton.addEventListener('click', () => verifySource(video));
  document.getElementById('faceImageInput').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { notify('เลือกไฟล์ภาพเท่านั้น'); event.target.value = ''; return; }
    const image = new Image(); image.onload = async () => { await verifySource(image); URL.revokeObjectURL(image.src); event.target.value = ''; }; image.onerror = () => { notify('เปิดภาพนี้ไม่ได้'); event.target.value = ''; }; image.src = URL.createObjectURL(file);
  });

  startButton.addEventListener('click', openCamera);
  stopButton.addEventListener('click', () => {
    stopCamera();
    notify('ปิดกล้องแล้ว');
  });
  select.addEventListener('change', () => {
    if (stream) openCamera();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', populateCameras);

  document.getElementById('today').textContent = new Intl.DateTimeFormat('th-TH', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  }).format(new Date());
  const time = document.getElementById('cameraTime');
  const updateTime = () => { time.textContent = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()); };
  updateTime();
  setInterval(updateTime, 1000);

  document.getElementById('refreshButton').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('fa:refresh'));
  });
  const sidebar = document.getElementById('sidebar');
  document.getElementById('menuToggle').addEventListener('click', () => sidebar.classList.toggle('open'));
  document.addEventListener('click', event => {
    if (window.innerWidth <= 760 && sidebar.classList.contains('open') &&
        !sidebar.contains(event.target) && !event.target.closest('#menuToggle')) sidebar.classList.remove('open');
  });

  populateCameras();
  window.addEventListener('pagehide', () => {
    if (stream) cameraAdapter.close();
  });
})();
