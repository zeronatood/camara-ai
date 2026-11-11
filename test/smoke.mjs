import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const dbPath=fileURLToPath(new URL('./smoke.sqlite',import.meta.url));
process.env.FACE_ATTENDANCE_DB=dbPath;
const {openDatabase}=await import('../db.mjs');
const port=8127,key=randomBytes(32).toString('hex'),password='TestOnly-Pass-93!';
const db=openDatabase();
for(const [username,name,role] of [['testadmin','Admin Test','admin'],['testteacher','Teacher Test','teacher']]){
  const salt=randomBytes(16);
  db.prepare('INSERT INTO users(username,display_name,role,salt,password_hash) VALUES(?,?,?,?,?)').run(username,name,role,salt.toString('hex'),scryptSync(password,salt,64).toString('hex'));
}
const studentId=Number(db.prepare("INSERT INTO students(student_code,first_name,last_name,grade,room) VALUES('SMOKE-001','ทดสอบ','ระบบ','ม.1','1')").run().lastInsertRowid);
db.close();
const child=spawn(process.execPath,['../server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,FACE_ATTENDANCE_DB:dbPath,FACE_TEMPLATE_KEY:key,FACE_ATTENDANCE_HOST:'127.0.0.1',FACE_ATTENDANCE_PORT:String(port)},stdio:'ignore',windowsHide:true});
const base=`http://127.0.0.1:${port}`; let cookie='',csrf='';
async function request(path,body,method='GET'){
  const headers={}; if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET'){headers.Origin=base;if(csrf)headers['X-CSRF-Token']=csrf;} if(cookie)headers.Cookie=cookie;
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  let data={};try{data=await response.json()}catch{} return {status:response.status,data,response};
}
function assert(value,message){if(!value)throw new Error(message)}
try{
  let health; for(let i=0;i<50;i++){try{health=await fetch(base+'/api/health');if(health.ok)break}catch{}await delay(100)} assert(health?.ok,'server startup');
  let login=await request('/api/auth/login',{username:'testadmin',password},'POST');assert(login.status===200,'admin login');cookie=login.response.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
  let data=await request('/api/students');assert(data.status===200&&data.data.students.length===1,'student list');
  let created=await request('/api/students',{studentCode:'SMOKE-002',firstName:'ตัวอย่าง',lastName:'ทดสอบ',grade:'ม.2',room:'2'},'POST');assert(created.status===201,'create student');
  let consent=await request(`/api/students/${studentId}/consent`,{granted:true},'POST');assert(consent.status===200,'grant consent');
  const embedding=Array.from({length:1024},(_,i)=>i===0?1:0);
  let enroll=await request('/api/face/enroll',{studentId,embedding},'POST');assert(enroll.status===201,'encrypted face enrollment');
  let noMatch=await request('/api/face/verify',{embedding:Array.from({length:1024},(_,i)=>i===1?1:0)},'POST');assert(noMatch.status===200&&noMatch.data.status==='review'&&noMatch.data.candidate===null,'unmatched face requires fallback');
  let verify=await request('/api/face/verify',{embedding},'POST');assert(verify.status===200&&verify.data.status==='teacher_review','face verification requires review');
  let attendance=await request('/api/face/confirm',{reviewToken:verify.data.reviewToken},'POST');assert(attendance.status===201,'teacher confirmation');
  let duplicateFaceMatch=await request('/api/face/verify',{embedding},'POST');let duplicateFace=await request('/api/face/confirm',{reviewToken:duplicateFaceMatch.data.reviewToken},'POST');assert(duplicateFace.status===409,'duplicate face attendance blocked');
  let duplicate=await request('/api/attendance',{studentId,status:'present'},'POST');assert(duplicate.status===409,'duplicate attendance blocked');
  let report=await request('/api/reports');assert(report.status===200&&report.data.records.some(r=>r.studentCode==='SMOKE-001'),'report includes confirmed attendance');
  let dashboard=await request('/api/dashboard');assert(dashboard.status===200&&dashboard.data.stats.present+dashboard.data.stats.late===1,'dashboard stats');
  let settings=await request('/api/settings');assert(settings.status===200&&settings.data.startsAt==='08:00'&&settings.data.lateAfter==='08:15','attendance settings load');
  let savedSettings=await request('/api/settings',{startsAt:'07:45',lateAfter:'08:05',matchThreshold:0.9},'PATCH');assert(savedSettings.status===200&&savedSettings.data.startsAt==='07:45','admin can update attendance settings');
  let invalidSettings=await request('/api/settings',{startsAt:'09:00',lateAfter:'08:00',matchThreshold:0.9},'PATCH');assert(invalidSettings.status===400,'invalid attendance times rejected');
  let userList=await request('/api/users');assert(userList.status===200&&userList.data.users.length===2,'admin can list user accounts');
  let newUser=await request('/api/users',{username:'newteacher',displayName:'New Teacher',password:'Temporary-Pass-93!',role:'teacher'},'POST');assert(newUser.status===201,'admin can create user account');
  let toggleUser=await request(`/api/users/${newUser.data.id}`,{active:false},'PATCH');assert(toggleUser.status===200,'admin can suspend user account');
  let revoke=await request(`/api/students/${studentId}/consent`,{granted:false},'POST');assert(revoke.status===200,'revoke consent');let afterRevoke=await request('/api/face/verify',{embedding},'POST');assert(afterRevoke.status===200&&afterRevoke.data.status==='review','revoked template cannot match');
  await request('/api/auth/logout',{},'POST');cookie='';csrf='';let teacher=await request('/api/auth/login',{username:'testteacher',password},'POST');assert(teacher.status===200,'teacher login');cookie=teacher.response.headers.get('set-cookie').split(';')[0];csrf=teacher.data.csrf;
  let denied=await request('/api/students',{studentCode:'NOPE',firstName:'No',lastName:'Access',grade:'ม.1',room:'1'},'POST');assert(denied.status===403,'teacher admin-only restriction');
  let deniedUsers=await request('/api/users');assert(deniedUsers.status===403,'teacher cannot manage accounts');
  let deniedSettings=await request('/api/settings',{startsAt:'07:00',lateAfter:'08:00',matchThreshold:0.9},'PATCH');assert(deniedSettings.status===403,'teacher cannot change system settings');
  console.log('ผ่าน: login/role, จัดการบัญชีและสิทธิ์, นักเรียน/consent, ตั้งค่าเวลาและเกณฑ์ใบหน้า, เข้ารหัสแม่แบบ, teacher review, กันเช็กชื่อซ้ำ, report และ dashboard');
}catch(error){console.error('ทดสอบไม่ผ่าน:',error.stack||error);process.exitCode=1;}
finally{child.kill();await delay(300);for(const file of [dbPath,dbPath+'-shm',dbPath+'-wal'])try{fs.rmSync(file,{force:true})}catch{}}
