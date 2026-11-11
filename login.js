(() => {
  const form=document.getElementById('loginForm'),error=document.getElementById('loginError'),button=document.getElementById('loginSubmit'),health=document.getElementById('healthStatus');
  const setup=document.getElementById('setupNotice');
  FA.api('/api/health').then(data=>{
    health.textContent=data.ok?(data.backend==='supabase'?'เชื่อมต่อ Supabase แล้ว':'เซิร์ฟเวอร์พร้อมใช้งาน')+(data.faceKeyReady?' · เข้ารหัสแม่แบบพร้อม':''): 'ระบบไม่พร้อม';
    health.classList.toggle('ok',Boolean(data.ok));
    if(setup&&data.setupRequired){setup.hidden=false;form.hidden=true;}
  }).catch(()=>{health.textContent=FA.cloud?'เชื่อมต่อ Supabase ไม่สำเร็จ':'ไม่พบเซิร์ฟเวอร์ · กรุณาเริ่มระบบด้วย npm start';health.classList.add('error');});
  document.getElementById('copyBootstrapSql')?.addEventListener('click',async()=>{
    const status=document.getElementById('copySqlStatus');
    try{await navigator.clipboard.writeText(document.getElementById('bootstrapSql').textContent);status.textContent='คัดลอกแล้ว · แทนค่า UUID และอีเมลก่อนรัน';}
    catch{status.textContent='คัดลอกไม่สำเร็จ · เลือกและคัดลอก SQL ด้วยตนเอง';}
  });
  form.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';button.disabled=true;button.textContent='กำลังเข้าสู่ระบบ…';const data=Object.fromEntries(new FormData(form));
    try{await FA.login(data);location.replace('/index.html');}
    catch(err){error.textContent=err.message;button.disabled=false;button.textContent='เข้าสู่ระบบ';}
  });
})();
