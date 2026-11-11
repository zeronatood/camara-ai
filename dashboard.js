(() => {
  const $=selector=>document.querySelector(selector);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmtTime=value=>value?new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit'}).format(new Date(value))+' น.':'—';
  function notify(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),3000);}
  async function loadDashboard(){
    try{
      const data=await FA.api('/api/dashboard');
      const values=[data.stats.total,data.stats.present,data.stats.late,data.stats.missing];
      document.querySelectorAll('.stats-grid .stat-number').forEach((element,index)=>{element.innerHTML=`${values[index]??0} <small>คน</small>`;});
      const feet=document.querySelectorAll('.stats-grid .stat-foot');
      feet[0].textContent='ข้อมูลจากฐานข้อมูลในเครื่อง';
      feet[1].innerHTML=`<span class="green-text">${data.stats.total?Math.round((data.stats.present+data.stats.late)*100/data.stats.total):0}%</span> ของนักเรียนทั้งหมด`;
      feet[2].textContent='บันทึกวันนี้';feet[3].textContent='ไม่มีรายการที่บันทึก';
      const checked=data.stats.present+data.stats.late;
      const presentPct=data.stats.total?data.stats.present*100/data.stats.total:0;
      const latePct=data.stats.total?data.stats.late*100/data.stats.total:0;
      const checkedPct=presentPct+latePct;
      const donut=$('.donut');donut.style.background=`conic-gradient(#6d59dc 0 ${presentPct}%,#f1a354 ${presentPct}% ${checkedPct}%,#e8e8ef ${checkedPct}% 100%)`;
      donut.setAttribute('aria-label',`มาเรียน ${data.stats.present} คน มาสาย ${data.stats.late} คน ยังไม่มีรายการ ${data.stats.missing} คน`);
      $('.donut-center b').innerHTML=`${data.stats.total?Math.round(checkedPct):0}<span>%</span>`;
      $('.donut-center small').textContent='มีรายการแล้ว';
      const legend=$$('.legend>div');
      [data.stats.present,data.stats.late,data.stats.missing].forEach((value,index)=>{if(legend[index])legend[index].lastElementChild.textContent=value;});
      $('.class-summary b').textContent=`${data.byClass.length} ห้อง`;
      $('.class-bars').innerHTML=data.byClass.slice(0,5).map(room=>{const percent=room.total?Math.round(room.checked*100/room.total):0;return `<div><span>${esc(room.grade)}/${esc(room.room)}</span><div class="bar-bg"><i style="width:${percent}%"></i></div><b>${percent}%</b></div>`;}).join('')||'<div class="empty-chart">ยังไม่มีข้อมูลห้องเรียน</div>';
      const body=$('.activity-panel tbody');
      body.innerHTML=data.recent.map((item,index)=>`<tr><td><span class="student-cell"><span class="student-avatar a${index%3+1}">${esc([...item.firstName][0])}</span><b>${esc(item.firstName)} ${esc(item.lastName)}</b></span></td><td>${esc(item.studentCode)}</td><td>${esc(item.grade)} / ${esc(item.room)}</td><td>${fmtTime(item.checkedAt)}</td><td><span class="status-pill ${item.status==='late'?'late':'present'}">● ${item.status==='late'?'มาสาย':'มาเรียน'}</span></td></tr>`).join('')||'<tr><td colspan="5" class="no-records">ยังไม่มีรายการเช็กชื่อ · การไม่พบใบหน้าไม่ถูกนับเป็นขาดเรียน</td></tr>';
      $('.activity-heading p').textContent=`รายการจากฐานข้อมูลวันนี้ ${data.date}`;
      return true;
    }catch(error){notify(error.message);return false;}
  }
  const $$=selector=>[...document.querySelectorAll(selector)];
  window.addEventListener('fa:ready',loadDashboard);
  window.addEventListener('fa:refresh',async()=>notify(await loadDashboard()?'อัปเดตข้อมูลแล้ว':'อัปเดตไม่สำเร็จ'));
})();
