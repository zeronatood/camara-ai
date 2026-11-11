(() => {
  'use strict';
  const $=selector=>document.querySelector(selector);const form=$('#settingsForm');let messageTimer;
  function show(message,ok=false){const el=$('#settingsMessage');el.textContent=message;el.classList.toggle('success',ok);}
  async function load(){try{const value=await FA.api('/api/settings');$('#startsAt').value=value.startsAt;$('#lateAfter').value=value.lateAfter;$('#matchThreshold').value=value.matchThreshold;$('#thresholdLabel').textContent=Number(value.matchThreshold).toFixed(2);}catch(error){show(error.message);}}
  $('#matchThreshold').addEventListener('input',event=>$('#thresholdLabel').textContent=Number(event.target.value).toFixed(2));
  form.addEventListener('submit',async event=>{event.preventDefault();show('');const startsAt=$('#startsAt').value,lateAfter=$('#lateAfter').value;if(!startsAt||!lateAfter||lateAfter<startsAt){show('เวลาเริ่มสายต้องเท่ากับหรือหลังเวลาเริ่มเรียน');return;}const button=$('#saveSettings');button.disabled=true;button.textContent='กำลังบันทึก…';try{const result=await FA.api('/api/settings',{method:'PATCH',body:JSON.stringify({startsAt,lateAfter,matchThreshold:Number($('#matchThreshold').value)})});$('#startsAt').value=result.startsAt;$('#lateAfter').value=result.lateAfter;$('#matchThreshold').value=result.matchThreshold;$('#thresholdLabel').textContent=Number(result.matchThreshold).toFixed(2);show('บันทึกการตั้งค่าแล้ว',true);}catch(error){show(error.message);}finally{button.disabled=false;button.textContent='บันทึกการตั้งค่า';}});
  $('#menuToggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
  window.addEventListener('fa:ready',event=>{if(event.detail.user.role!=='admin'){location.replace('index.html');return;}$('#today').textContent=new Intl.DateTimeFormat('th-TH',{weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(new Date());load();});
})();
