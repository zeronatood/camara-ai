import { audit, authorize, bangkokDate, cosine, db, decryptEmbedding, encryptEmbedding, json, latestConsent, readBody, validateEmbedding } from './_shared.ts';

const ok = (data:unknown, status=200) => json(data,status);
const fail = (message:string,status=400) => json({error:message},status);
const isId = (v:string) => /^\d+$/.test(v);
const safeError = (error:unknown) => {
  const e=error as {message?:string;status?:number;code?:string};
  if (e.status) return fail(e.message||'คำขอไม่สำเร็จ',e.status);
  if (e.code==='23505') return fail('มีรายการนี้อยู่แล้วหรือเช็กชื่อไปแล้ว',409);
  if (e.code==='23503') return fail('ข้อมูลที่เลือกไม่ถูกต้อง',400);
  console.error('app-api error',e.code||'unknown',e.message||'');
  return fail('ระบบขัดข้องชั่วคราว กรุณาลองใหม่',500);
};
const checked = <T>(result:{data:T|null;error:{message:string;code?:string}|null}) => { if(result.error) throw result.error; return result.data as T; };
async function consentMap(ids:number[]) {
  if(!ids.length)return new Map<number,string>();
  const rows=checked(await db.from('face_consents').select('student_id,status,recorded_at').in('student_id',ids).order('recorded_at',{ascending:false}).order('id',{ascending:false}));
  const result=new Map<number,string>(); for(const row of rows as any[])if(!result.has(row.student_id))result.set(row.student_id,row.status); return result;
}
function studentDto(s:any,consents:Map<number,string>) {
  const c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms;
  return {id:s.id,studentCode:s.student_code,firstName:s.first_name,lastName:s.last_name,grade:c?.grade||'',room:c?.room||'',active:s.active,portraitData:s.portrait_data||null,consent:consents.get(s.id)||'none',consentAt:null,faceStatus:s.face_registered?'registered':'none'};
}
function portraitValue(value:unknown) {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>180_000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw Object.assign(new Error('รูปประจำตัวไม่ถูกต้องหรือมีขนาดใหญ่เกินกำหนด'),{status:400});
  return value;
}
async function log(actor:string, action:string, entity:string, id:string|number, details:Record<string,unknown>={}) { await audit(actor,action,entity,id,details); }
async function handle(req:Request) {
  if(req.method==='OPTIONS')return new Response('ok',{headers:{...Object.fromEntries(Object.entries({})),...{ 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, PATCH, OPTIONS' }}});
  let input:any={};
  if(req.method==='POST'||req.method==='PATCH')input=await readBody(req);
  const rawPath=String(input.path||new URL(req.url).searchParams.get('path')||'');
  const pathUrl=new URL(rawPath,'https://face-attendance.invalid'); const path=pathUrl.pathname; const method=String(input.method||req.method).toUpperCase();
  if(path==='/api/health'){
    const status=await db.from('users').select('id',{count:'exact',head:true});
    if(status.error)throw status.error;
    return ok({ok:true,backend:'supabase',faceEngine:'on-device',setupRequired:(status.count||0)===0});
  }
  const {profile,user}=await authorize(req);
  const admin=profile.role==='admin';

  if(path==='/api/me'&&method==='GET')return ok({user:{id:profile.id,username:user.email,displayName:profile.display_name,role:profile.role}});
  if(path==='/api/auth/logout'&&method==='POST')return ok({ok:true});

  if(path==='/api/students'&&method==='GET'){
    const rows=checked(await db.from('students').select('id,student_code,first_name,last_name,portrait_data,active,face_registered,classrooms(grade,room)').eq('active',true).order('student_code')) as any[];
    const consents=await consentMap(rows.map(s=>s.id)); return ok({students:rows.map(s=>studentDto(s,consents))});
  }
  if(path==='/api/students'&&method==='POST'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้',403);
    const data=input.body||{}; const code=String(data.studentCode||'').trim(),first=String(data.firstName||'').trim(),last=String(data.lastName||'').trim(),grade=String(data.grade||'').trim(),room=String(data.room||'').trim();
    if(!code||!first||!last||!grade||!room||[code,first,last,grade,room].some(x=>x.length>80))return fail('กรุณากรอกข้อมูลนักเรียนให้ครบ');
    let classroom=checked(await db.from('classrooms').select('id').eq('grade',grade).eq('room',room).maybeSingle()) as any;
    if(!classroom)classroom=checked(await db.from('classrooms').insert({grade,room}).select('id').single()) as any;
    const row=checked(await db.from('students').insert({student_code:code,first_name:first,last_name:last,portrait_data:portraitValue(data.portraitData),grade,room,classroom_id:classroom.id}).select('id,student_code,first_name,last_name,portrait_data,active,face_registered,classrooms(grade,room)').single()) as any;
    await log(user.id,'student.create','student',row.id);return ok(studentDto(row,new Map()),201);
  }
  const studentAction=path.match(/^\/api\/students\/(\d+)$/);
  if(studentAction&&method==='PATCH'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้',403);
    const data=input.body||{};const id=Number(studentAction[1]);const grade=String(data.grade||'').trim(),room=String(data.room||'').trim();
    let classroom=checked(await db.from('classrooms').select('id').eq('grade',grade).eq('room',room).maybeSingle()) as any;if(!classroom)classroom=checked(await db.from('classrooms').insert({grade,room}).select('id').single()) as any;
    const changes:any={student_code:String(data.studentCode||'').trim(),first_name:String(data.firstName||'').trim(),last_name:String(data.lastName||'').trim(),grade,room,classroom_id:classroom.id,updated_at:new Date().toISOString()};if(Object.hasOwn(data,'portraitData'))changes.portrait_data=portraitValue(data.portraitData);
    const row=checked(await db.from('students').update(changes).eq('id',id).eq('active',true).select('id,student_code,first_name,last_name,portrait_data,active,face_registered,classrooms(grade,room)').single()) as any;
    await log(user.id,'student.update','student',id);return ok(studentDto(row,await consentMap([id])));
  }
  if(studentAction&&method==='DELETE'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้',403);
    const id=Number(studentAction[1]);const timestamp=new Date().toISOString();
    checked(await db.from('face_consents').insert({student_id:id,status:'revoked',version:'archive-v1',recorded_by:user.id}));
    checked(await db.from('face_templates').delete().eq('student_id',id));
    checked(await db.from('students').update({active:false,face_registered:false,updated_at:timestamp}).eq('id',id));
    await log(user.id,'student.archive','student',id);return ok({ok:true});
  }
  const consentAction=path.match(/^\/api\/students\/(\d+)\/consent$/);
  if(consentAction&&method==='POST'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบจัดการความยินยอมได้',403);
    const id=Number(consentAction[1]),granted=Boolean(input.body?.granted);
    checked(await db.from('face_consents').insert({student_id:id,status:granted?'granted':'revoked',version:'consent-v1',recorded_by:user.id}));
    if(!granted){checked(await db.from('face_templates').delete().eq('student_id',id));checked(await db.from('students').update({face_registered:false}).eq('id',id));}
    await log(user.id,granted?'consent.grant':'consent.revoke','student',id);return ok({ok:true,status:granted?'granted':'revoked'});
  }

  if(path==='/api/face/enroll'&&method==='POST'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบลงทะเบียนใบหน้าได้',403);
    const id=Number(input.body?.studentId);if(!Number.isInteger(id))return fail('รหัสนักเรียนไม่ถูกต้อง');const query=validateEmbedding(input.body?.embedding);
    const student=checked(await db.from('students').select('id,active').eq('id',id).single()) as any;
    if(!student.active)return fail('นักเรียนถูกปิดใช้งาน');
    if((await consentMap([id])).get(id)!=='granted')return fail('ต้องได้รับความยินยอมล่าสุดก่อนลงทะเบียนใบหน้า',403);
    const templates=checked(await db.from('face_templates').select('student_id,ciphertext,iv,auth_tag,dimensions,model_version,created_by').neq('student_id',id)) as any[];
    if(templates.length){const consents=await consentMap(templates.map(x=>x.student_id));for(const row of templates){if(consents.get(row.student_id)!=='granted'||row.dimensions!==query.length)continue;const existing=await decryptEmbedding(row);if(cosine(query,existing)>=.88)return fail('แม่แบบนี้คล้ายกับข้อมูลของนักเรียนคนอื่นมากเกินไป กรุณาตรวจสอบและใช้ภาพอื่น',409);}}
    const encrypted=await encryptEmbedding(query);
    checked(await db.from('face_templates').upsert({student_id:id,...encrypted,dimensions:query.length,model_version:'human-3.3.6-faceres',created_by:user.id,created_at:new Date().toISOString()}));
    checked(await db.from('students').update({face_registered:true}).eq('id',id));
    await log(user.id,'face.enroll','student',id,{dimensions:query.length,model:'human-3.3.6-faceres'});return ok({ok:true,faceStatus:'registered'},201);
  }
  if(path==='/api/face/verify'&&method==='POST'){
    const query=validateEmbedding(input.body?.embedding);
    const rows=checked(await db.from('face_templates').select('student_id,ciphertext,iv,auth_tag,dimensions,model_version,created_by,students!inner(id,student_code,first_name,last_name,active,classroom_id,classrooms(grade,room))').eq('students.active',true)) as any[];
    const consents=await consentMap(rows.map(x=>x.student_id)),candidates:any[]=[];
    for(const row of rows){if(consents.get(row.student_id)!=='granted'||row.dimensions!==query.length)continue;const emb=await decryptEmbedding(row);candidates.push({row,similarity:cosine(query,emb)});}
    candidates.sort((a,b)=>b.similarity-a.similarity);const best=candidates[0],runner=candidates[1];
    const settings=checked(await db.from('attendance_settings').select('match_threshold').eq('id',true).single()) as any;const threshold=settings.match_threshold;
    if(!best||best.similarity<threshold||(runner&&best.similarity-runner.similarity<.04)){
      await log(user.id,'face.verify.uncertain','camera','local',{hasCandidates:Boolean(best)});
      return ok({status:'review',message:'ยังยืนยันตัวตนไม่ได้ กรุณาเช็กชื่อด้วยวิธีสำรองและให้ครูตรวจสอบ',candidate:null,similarity:best?Math.max(0,best.similarity):null,threshold});
    }
    const tokenBytes=crypto.getRandomValues(new Uint8Array(32));const token=btoa(String.fromCharCode(...tokenBytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));const tokenHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    checked(await db.from('face_review_tokens').insert({token_hash:tokenHash,student_id:best.row.student_id,user_id:user.id,confidence:best.similarity,expires_at:new Date(Date.now()+120_000).toISOString()}));
    const s=Array.isArray(best.row.students)?best.row.students[0]:best.row.students;const c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms;
    await log(user.id,'face.verify.candidate','camera','local',{candidateId:best.row.student_id});
    return ok({status:'teacher_review',message:'พบใบหน้าที่อาจตรงกัน · ครูต้องตรวจและยืนยันก่อนบันทึก',candidate:{studentCode:s.student_code,firstName:s.first_name,lastName:s.last_name,grade:c?.grade||'',room:c?.room||''},similarity:best.similarity,threshold,reviewToken:token});
  }
  if(path==='/api/face/confirm'&&method==='POST'){
    const token=String(input.body?.reviewToken||'');if(token.length<32)return fail('ผลตรวจหมดอายุ กรุณาตรวจใบหน้าใหม่');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const result=await db.rpc('confirm_face_attendance',{p_token_hash:hash,p_actor:user.id});
    if(result.error){if(result.error.code==='23505')return fail('นักเรียนคนนี้มีรายการเช็กชื่อในวันนี้แล้ว',409);if(result.error.message==='review_expired')return fail('ผลตรวจหมดอายุ กรุณาตรวจใบหน้าใหม่',409);if(result.error.message==='consent_revoked')return fail('ความยินยอมถูกถอนหรือรายชื่อนักเรียนถูกปิดแล้ว',403);throw result.error;}
    return ok({id:result.data.id,status:'confirmed',studentId:result.data.studentId,confidence:result.data.confidence},201);
  }

  if(path==='/api/settings'&&method==='GET'){
    const s=checked(await db.from('attendance_settings').select('starts_at,late_after,match_threshold').eq('id',true).single()) as any;
    return ok({startsAt:String(s.starts_at).slice(0,5),lateAfter:String(s.late_after).slice(0,5),matchThreshold:s.match_threshold});
  }
  if(path==='/api/settings'&&method==='PATCH'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบเปลี่ยนการตั้งค่าได้',403);
    const d=input.body||{};if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.startsAt)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.lateAfter)||d.lateAfter<d.startsAt||!Number.isFinite(d.matchThreshold)||d.matchThreshold<.5||d.matchThreshold>.99)return fail('เวลาและเกณฑ์ความมั่นใจไม่ถูกต้อง');
    checked(await db.from('attendance_settings').update({starts_at:d.startsAt,late_after:d.lateAfter,match_threshold:d.matchThreshold,updated_by:user.id,updated_at:new Date().toISOString()}).eq('id',true));
    await log(user.id,'settings.update','settings','1',{startsAt:d.startsAt,lateAfter:d.lateAfter,matchThreshold:d.matchThreshold});return ok(d);
  }

  if(path==='/api/attendance'&&method==='GET'){
    const date=pathUrl.searchParams.get('date')||bangkokDate();const students=checked(await db.from('students').select('id,student_code,first_name,last_name,active,classrooms(grade,room)').eq('active',true).order('student_code')) as any[];
    const attendance=checked(await db.from('attendance_records').select('id,student_id,status,checked_at,source,confidence,note').eq('attendance_date',date)) as any[];const byId=new Map(attendance.map(a=>[a.student_id,a]));
    return ok({date,records:students.map(s=>{const c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms,a=byId.get(s.id);return {studentId:s.id,studentCode:s.student_code,firstName:s.first_name,lastName:s.last_name,grade:c?.grade||'',room:c?.room||'',recordId:a?.id||null,status:a?.status||null,checkedAt:a?.checked_at||null,source:a?.source||null,confidence:a?.confidence||null,note:a?.note||''};})});
  }
  if(path==='/api/attendance'&&method==='POST'){
    const d=input.body||{},studentId=Number(d.studentId),date=String(d.date||bangkokDate());if(!Number.isInteger(studentId)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['present','late','absent','excused'].includes(d.status))return fail('ข้อมูลการเข้าเรียนไม่ถูกต้อง');
    if(d.status==='absent'&&!admin)return fail('เฉพาะผู้ดูแลระบบบันทึกสถานะขาดเรียนได้',403);
    const record=checked(await db.from('attendance_records').insert({student_id:studentId,attendance_date:date,status:d.status,checked_at:['absent','excused'].includes(d.status)?null:new Date().toISOString(),source:'manual',reviewed_by:user.id,note:String(d.note||'').slice(0,240)}).select('id').single()) as any;
    await log(user.id,'attendance.create','attendance',record.id,{studentId,date,status:d.status,source:'manual'});return ok({id:record.id,date,status:d.status},201);
  }
  const attendanceId=path.match(/^\/api\/attendance\/(\d+)$/);
  if(attendanceId&&method==='PATCH'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบแก้ไขรายการเช็กชื่อได้',403);const d=input.body||{};if(!['present','late','absent','excused'].includes(d.status))return fail('สถานะไม่ถูกต้อง');
    const id=Number(attendanceId[1]);checked(await db.from('attendance_records').update({status:d.status,checked_at:['absent','excused'].includes(d.status)?null:new Date().toISOString(),source:'edit',reviewed_by:user.id,note:String(d.note||'').slice(0,240),updated_at:new Date().toISOString()}).eq('id',id));
    await log(user.id,'attendance.update','attendance',id,{status:d.status});return ok({ok:true});
  }

  if(path==='/api/dashboard'&&method==='GET'){
    const date=pathUrl.searchParams.get('date')||bangkokDate();const students=checked(await db.from('students').select('id,first_name,last_name,student_code,active,classrooms(grade,room)').eq('active',true)) as any[];
    const rows=checked(await db.from('attendance_records').select('id,student_id,status,checked_at,students!inner(student_code,first_name,last_name,classrooms(grade,room))').eq('attendance_date',date)) as any[];
    const stats={total:students.length,present:0,late:0,absent:0,excused:0,missing:0};for(const a of rows)if(a.status in stats)(stats as any)[a.status]++;stats.missing=Math.max(0,students.length-rows.length);
    const byClassMap=new Map<string,{grade:string;room:string;total:number;checked:number}>();for(const s of students){const c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms,key=`${c?.grade||''}/${c?.room||''}`;const v=byClassMap.get(key)||{grade:c?.grade||'',room:c?.room||'',total:0,checked:0};v.total++;byClassMap.set(key,v);}
    for(const a of rows){const s=Array.isArray(a.students)?a.students[0]:a.students,c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms,key=`${c?.grade||''}/${c?.room||''}`,v=byClassMap.get(key);if(v&&['present','late'].includes(a.status))v.checked++;}
    const recent=rows.filter(a=>['present','late'].includes(a.status)).sort((a,b)=>String(b.checked_at).localeCompare(String(a.checked_at))).slice(0,8).map(a=>{const s=Array.isArray(a.students)?a.students[0]:a.students,c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms;return {studentCode:s.student_code,firstName:s.first_name,lastName:s.last_name,grade:c?.grade||'',room:c?.room||'',checkedAt:a.checked_at,status:a.status,source:'manual'};});
    return ok({date,stats,recent,byClass:[...byClassMap.values()]});
  }

  if(path==='/api/reports'&&method==='GET'){
    const from=pathUrl.searchParams.get('from')||bangkokDate(),to=pathUrl.searchParams.get('to')||from;if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return fail('ช่วงวันที่ไม่ถูกต้อง');
    const all=checked(await db.from('attendance_records').select('attendance_date,status,checked_at,source,confidence,note,students!inner(student_code,first_name,last_name,active,classrooms(grade,room))').gte('attendance_date',from).lte('attendance_date',to).eq('students.active',true).order('attendance_date',{ascending:false})) as any[];
    const code=pathUrl.searchParams.get('studentCode')||'',grade=pathUrl.searchParams.get('grade')||'',room=pathUrl.searchParams.get('room')||'';
    const records=all.map(a=>{const s=Array.isArray(a.students)?a.students[0]:a.students,c=Array.isArray(s.classrooms)?s.classrooms[0]:s.classrooms;return {studentCode:s.student_code,firstName:s.first_name,lastName:s.last_name,grade:c?.grade||'',room:c?.room||'',date:a.attendance_date,status:a.status,checkedAt:a.checked_at,source:a.source,confidence:a.confidence,note:a.note};}).filter(a=>(!code||a.studentCode.includes(code))&&(!grade||a.grade===grade)&&(!room||a.room===room));
    return ok({from,to,records});
  }

  if(path==='/api/users'&&method==='GET'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบ',403);const rows=checked(await db.from('users').select('id,email,display_name,role,active,created_at').order('created_at')) as any[];
    return ok({users:rows.map(u=>({id:u.id,username:u.email,displayName:u.display_name,role:u.role,active:u.active,createdAt:u.created_at}))});
  }
  if(path==='/api/users'&&method==='POST'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบ',403);const d=input.body||{},email=String(d.email||d.username||'').trim().toLowerCase(),displayName=String(d.displayName||'').trim(),password=String(d.password||''),role=d.role;
    if(!/^\S+@\S+\.\S+$/.test(email)||!displayName||password.length<12||!['admin','teacher'].includes(role))return fail('กรุณากรอกอีเมล ชื่อ บทบาท และรหัสผ่านอย่างน้อย 12 ตัวอักษร');
    const created=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:displayName}});if(created.error)throw created.error;
    const result=await db.from('users').insert({id:created.data.user.id,email,display_name:displayName,role,active:true});
    if(result.error){await db.auth.admin.deleteUser(created.data.user.id);throw result.error;}
    await log(user.id,'user.create','user',created.data.user.id,{role});return ok({id:created.data.user.id,username:email,displayName,role},201);
  }
  const userId=path.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if(userId&&method==='PATCH'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบ',403);const id=userId[1],active=input.body?.active;if(typeof active!=='boolean')return fail('สถานะไม่ถูกต้อง');if(id===user.id&&!active)return fail('ไม่สามารถปิดบัญชีที่กำลังใช้อยู่');
    if(!active){const {count}=await db.from('users').select('id',{count:'exact',head:true}).eq('active',true).eq('role','admin');const target=checked(await db.from('users').select('role,active').eq('id',id).maybeSingle()) as any;if(target?.role==='admin'&&target.active&&Number(count)<=1)return fail('ต้องมีบัญชีผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งบัญชี');}
    checked(await db.from('users').update({active}).eq('id',id));if(!active)await db.auth.admin.updateUserById(id,{ban_duration:'876000h'});else await db.auth.admin.updateUserById(id,{ban_duration:'none'});await log(user.id,'user.update','user',id,{active});return ok({ok:true});
  }
  if(path==='/api/audit'&&method==='GET'){
    if(!admin)return fail('เฉพาะผู้ดูแลระบบ',403);const rows=checked(await db.from('audit_logs').select('id,actor_id,action,entity,entity_id,details,created_at').order('id',{ascending:false}).limit(100)) as any[];
    const ids=[...new Set(rows.map(r=>r.actor_id).filter(Boolean))];const users=ids.length?checked(await db.from('users').select('id,email,display_name').in('id',ids)):[];const map=new Map((users as any[]).map(u=>[u.id,u]));return ok({logs:rows.map(r=>{const u=map.get(r.actor_id);return {id:r.id,action:r.action,entity:r.entity,entityId:r.entity_id,details:r.details,createdAt:r.created_at,username:u?.email||'',displayName:u?.display_name||''};})});
  }
  return fail('ไม่พบ API',404);
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, PATCH, OPTIONS'}});
  try{return await handle(req);}catch(error){return safeError(error);}
});
