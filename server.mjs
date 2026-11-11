import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, audit } from './db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const db = openDatabase();
const sessions = new Map();
const loginAttempts = new Map();
const pendingFaceReviews = new Map();
const PORT = Number(process.env.FACE_ATTENDANCE_PORT || 8000);
const HOST = process.env.FACE_ATTENDANCE_HOST || '127.0.0.1';
const encryptionKey = /^[0-9a-f]{64}$/i.test(process.env.FACE_TEMPLATE_KEY || '') ? Buffer.from(process.env.FACE_TEMPLATE_KEY, 'hex') : null;
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.wasm':'application/wasm','.bin':'application/octet-stream' };

const nowISO = () => new Date().toISOString();
function bangkokDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extraHeaders });
  res.end(body);
}
function fail(res, status, message) { json(res, status, { error:message }); }
function cookieMap(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const at = item.indexOf('='); return [item.slice(0,at), decodeURIComponent(item.slice(at+1))];
  }));
}
async function body(req, max = 48_000) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size += chunk.length; if (size > max) { const error=new Error('ขนาดข้อมูลเกินกำหนด'); error.status=413; throw error; } chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const error=new Error('รูปแบบข้อมูลไม่ถูกต้อง'); error.status=400; throw error; }
}
function currentSession(req) {
  const id=cookieMap(req).fa_session; const session=id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) { if (id) sessions.delete(id); return null; }
  const user=db.prepare('SELECT id, username, display_name AS displayName, role, active FROM users WHERE id=?').get(session.userId);
  if (!user?.active) { sessions.delete(id); return null; }
  return { id, session, user };
}
function sameOrigin(req) {
  const origin=req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function csrf(req, session) { return sameOrigin(req) && req.headers['x-csrf-token'] === session.csrf; }
async function auth(req, res, roles = null, needsCsrf = false) {
  const current=currentSession(req);
  if (!current) { fail(res,401,'กรุณาเข้าสู่ระบบใหม่'); return null; }
  if (roles && !roles.includes(current.user.role)) { fail(res,403,'ไม่มีสิทธิ์ดำเนินการนี้'); return null; }
  if (needsCsrf && !csrf(req,current.session)) { fail(res,403,'คำขอไม่ผ่านการตรวจสอบความปลอดภัย กรุณาโหลดหน้าใหม่'); return null; }
  return current;
}
function latestConsent(studentId) {
  return db.prepare('SELECT status, version, recorded_at AS recordedAt FROM face_consents WHERE student_id=? ORDER BY id DESC LIMIT 1').get(studentId) || null;
}
function studentRow(row) {
  const consent=latestConsent(row.id);
  return { id:row.id, studentCode:row.student_code, firstName:row.first_name, lastName:row.last_name, grade:row.grade, room:row.room, active:Boolean(row.active), portraitData:row.portrait_data||null, consent:consent?.status || 'none', consentAt:consent?.recordedAt || null, faceStatus:db.prepare('SELECT 1 AS yes FROM face_templates WHERE student_id=?').get(row.id)?'registered':'none' };
}
function portraitValue(value) {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>180_000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw Object.assign(new Error('รูปประจำตัวไม่ถูกต้องหรือมีขนาดใหญ่เกินกำหนด'),{status:400});
  return value;
}
function auditSafe(user, action, entity, id, details = {}) { audit(db,user.id,action,entity,id,details); }
function auditDetails(obj) { return JSON.stringify(obj).slice(0,300); }
function getSettings() { return db.prepare('SELECT starts_at AS startsAt, late_after AS lateAfter, match_threshold AS matchThreshold FROM attendance_settings WHERE id=1').get(); }
function localClassDate() { return bangkokDate(); }
function statusByTime(date = new Date()) {
  const settings=getSettings();
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
  return time >= settings.lateAfter ? 'late' : 'present';
}
function recordAttendance({studentId,date,status,source,confidence=null,user,note=''}) {
  const student=db.prepare('SELECT id,active FROM students WHERE id=?').get(studentId);
  if (!student || !student.active) throw Object.assign(new Error('ไม่พบนักเรียนที่กำลังศึกษาอยู่'),{status:404});
  const checkedAt=status==='absent'||status==='excused'?null:nowISO();
  const result=db.prepare(`INSERT INTO attendance_records(student_id,attendance_date,status,checked_at,source,confidence,reviewed_by,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(studentId,date,status,checkedAt,source,confidence,user.id,note);
  auditSafe(user, 'attendance.create','attendance',result.lastInsertRowid,{studentId,date,status,source});
  return result.lastInsertRowid;
}
function decodeTemplate(row) {
  if (!encryptionKey) throw Object.assign(new Error('ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสแม่แบบใบหน้า'),{status:503});
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey,Buffer.from(row.iv,'hex'));
  decipher.setAuthTag(Buffer.from(row.auth_tag,'hex'));
  const clear=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,'base64')),decipher.final()]).toString('utf8');
  return JSON.parse(clear);
}
function encodeTemplate(embedding) {
  if (!encryptionKey) throw Object.assign(new Error('ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสแม่แบบใบหน้า'),{status:503});
  const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(embedding),'utf8'),cipher.final()]);
  return {ciphertext:encrypted.toString('base64'),iv:iv.toString('hex'),authTag:cipher.getAuthTag().toString('hex')};
}
function validateEmbedding(value) {
  if (!Array.isArray(value) || value.length < 128 || value.length > 2048 || !value.every(n=>Number.isFinite(n)&&Math.abs(n)<=100)) {
    throw Object.assign(new Error('ไม่พบแม่แบบใบหน้าที่ถูกต้อง กรุณาลองถ่ายใหม่'),{status:400});
  }
  const norm=Math.sqrt(value.reduce((sum,n)=>sum+n*n,0));
  if (!Number.isFinite(norm)||norm<0.00001) throw Object.assign(new Error('แม่แบบใบหน้าว่างเปล่า'),{status:400});
  return value.map(n=>n/norm);
}
function cosine(a,b) {
  if (!Array.isArray(b)||a.length!==b.length) return -1;
  let dot=0,an=0,bn=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];an+=a[i]*a[i];bn+=b[i]*b[i];}
  return dot/(Math.sqrt(an)*Math.sqrt(bn)||1);
}
function parseDate(value, fallback) {
  const date=value || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw Object.assign(new Error('วันที่ไม่ถูกต้อง'),{status:400});
  return date;
}
function attendanceStatus(status) { return ['present','late','absent','excused'].includes(status); }
function escapeStatic(pathname) {
  let decoded;
  try { decoded=decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  return decoded;
}
async function staticFile(url,res) {
  const safe=escapeStatic(url.pathname);
  if (!safe) return fail(res,400,'คำขอไฟล์ไม่ถูกต้อง');
  if (safe.startsWith('/data/') || safe.startsWith('/node_modules/') || safe==='/package.json' || safe==='/package-lock.json' || safe==='/.env' || safe.startsWith('/db.') || safe.startsWith('/server.') || safe.startsWith('/setup.')) return fail(res,404,'ไม่พบไฟล์');
  if(safe==='/runtime-config.js'){
    const body='window.FA_CONFIG = { mode: "local" };';
    res.writeHead(200,{ 'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });res.end(body);return;
  }
  let filePath;
  if (safe==='/vendor/human.js') filePath=path.join(ROOT,'node_modules','@vladmandic','human','dist','human.js');
  else if (safe.startsWith('/vendor/models/')) filePath=path.join(ROOT,'node_modules','@vladmandic','human','models',path.basename(safe));
  else filePath=path.join(ROOT,safe==='/'?'index.html':safe.slice(1));
  if (!filePath.startsWith(ROOT)) return fail(res,403,'ไม่อนุญาต');
  let stat;
  try { stat=await fs.promises.stat(filePath); } catch { return fail(res,404,'ไม่พบไฟล์'); }
  if (!stat.isFile()) return fail(res,404,'ไม่พบไฟล์');
  const ext=path.extname(filePath).toLowerCase();
  if (!mime[ext]) return fail(res,404,'ไม่พบไฟล์');
  const headers={ 'Content-Type':mime[ext], 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY', 'Cache-Control':ext==='.bin'||ext==='.wasm'?'public, max-age=31536000, immutable':'no-cache', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" };
  res.writeHead(200,headers); fs.createReadStream(filePath).pipe(res);
}

const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method==='GET' && url.pathname.startsWith('/api/')) {
      if (url.pathname==='/api/health') return json(res,200,{ok:true,faceKeyReady:Boolean(encryptionKey),faceEngine:'Human 3.3.6 (browser, on-device)'});
      if (url.pathname==='/api/me') {
        const current=currentSession(req);
        if (!current) return json(res,200,{user:null});
        return json(res,200,{user:current.user,csrf:current.session.csrf});
      }
      const current=await auth(req,res); if (!current) return;
      if (url.pathname==='/api/students') {
        const list=db.prepare(`SELECT s.* FROM students s WHERE s.active=1 ORDER BY s.grade,s.room,s.last_name,s.first_name`).all().map(studentRow);
        return json(res,200,{students:list});
      }
      if (url.pathname==='/api/settings') return json(res,200,getSettings());
      if (url.pathname==='/api/dashboard') {
        const date=parseDate(url.searchParams.get('date'),localClassDate());
        const stats=db.prepare(`SELECT COUNT(*) total,
          SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present,
          SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) late,
          SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) absent,
          SUM(CASE WHEN a.status='excused' THEN 1 ELSE 0 END) excused,
          SUM(CASE WHEN s.id IS NOT NULL AND a.id IS NULL THEN 1 ELSE 0 END) missing
          FROM students s LEFT JOIN attendance_records a ON a.student_id=s.id AND a.attendance_date=? WHERE s.active=1`).get(date);
        const recent=db.prepare(`SELECT s.student_code AS studentCode,s.first_name AS firstName,s.last_name AS lastName,s.grade,s.room,a.checked_at AS checkedAt,a.status,a.source
          FROM attendance_records a JOIN students s ON s.id=a.student_id WHERE a.attendance_date=? ORDER BY a.checked_at DESC LIMIT 8`).all(date);
        const byClass=db.prepare(`SELECT s.grade,s.room,COUNT(*) total,SUM(CASE WHEN a.status IN('present','late') THEN 1 ELSE 0 END) checked
          FROM students s LEFT JOIN attendance_records a ON a.student_id=s.id AND a.attendance_date=? WHERE s.active=1 GROUP BY s.grade,s.room ORDER BY s.grade,s.room`).all(date);
        return json(res,200,{date,stats:{total:stats.total||0,present:stats.present||0,late:stats.late||0,absent:stats.absent||0,excused:stats.excused||0,missing:stats.missing||0},recent,byClass});
      }
      if (url.pathname==='/api/attendance') {
        const date=parseDate(url.searchParams.get('date'),localClassDate());
        const list=db.prepare(`SELECT s.id AS studentId,s.student_code AS studentCode,s.first_name AS firstName,s.last_name AS lastName,s.grade,s.room,
          a.id AS recordId,a.status,a.checked_at AS checkedAt,a.source,a.confidence,a.note
          FROM students s LEFT JOIN attendance_records a ON a.student_id=s.id AND a.attendance_date=? WHERE s.active=1 ORDER BY s.grade,s.room,s.last_name,s.first_name`).all(date);
        return json(res,200,{date,records:list});
      }
      if (url.pathname==='/api/reports') {
        const from=parseDate(url.searchParams.get('from'),localClassDate());
        const to=parseDate(url.searchParams.get('to'),from);
        if (from>to) return fail(res,400,'ช่วงวันที่ไม่ถูกต้อง');
        const params=[from,to]; let filter='';
        const grade=url.searchParams.get('grade'), room=url.searchParams.get('room'), code=url.searchParams.get('studentCode');
        if(grade){filter+=' AND s.grade=?';params.push(grade);} if(room){filter+=' AND s.room=?';params.push(room);} if(code){filter+=' AND s.student_code LIKE ?';params.push(`%${code}%`);}
        const data=db.prepare(`SELECT s.student_code AS studentCode,s.first_name AS firstName,s.last_name AS lastName,s.grade,s.room,
          a.attendance_date AS date,a.status,a.checked_at AS checkedAt,a.source,a.confidence,a.note
          FROM students s LEFT JOIN attendance_records a ON a.student_id=s.id AND a.attendance_date BETWEEN ? AND ?
          WHERE s.active=1${filter} ORDER BY a.attendance_date DESC,s.grade,s.room,s.last_name,s.first_name`).all(...params);
        return json(res,200,{from,to,records:data});
      }
      if (url.pathname==='/api/audit') {
        if(current.user.role!=='admin') return fail(res,403,'เฉพาะผู้ดูแลระบบ');
        const logs=db.prepare(`SELECT a.id,a.action,a.entity,a.entity_id AS entityId,a.details,a.created_at AS createdAt,u.username,u.display_name AS displayName
          FROM audit_logs a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`).all().map(row=>({...row,details:JSON.parse(row.details)}));
        return json(res,200,{logs});
      }
      if (url.pathname==='/api/users') {
        if(current.user.role!=='admin') return fail(res,403,'เฉพาะผู้ดูแลระบบ');
        return json(res,200,{users:db.prepare('SELECT id,username,display_name AS displayName,role,active,created_at AS createdAt FROM users ORDER BY id').all().map(u=>({...u,active:Boolean(u.active)}))});
      }
      return fail(res,404,'ไม่พบ API');
    }

    if (req.method==='POST' && url.pathname==='/api/auth/login') {
      if(!sameOrigin(req)) return fail(res,403,'ต้นทางคำขอไม่ถูกต้อง');
      const data=await body(req,8000); const username=String(data.username||'').trim().slice(0,40); const password=String(data.password||'');
      const key=`${req.socket.remoteAddress}:${username.toLowerCase()}`; const attempt=loginAttempts.get(key)||{count:0,until:0};
      if(attempt.until>Date.now()) return fail(res,429,'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่');
      const user=db.prepare('SELECT id,username,display_name AS displayName,role,salt,password_hash AS passwordHash,active FROM users WHERE username=? COLLATE NOCASE').get(username);
      const salt=user?Buffer.from(user.salt,'hex'):Buffer.alloc(16); const candidate=scryptSync(password,salt,64);
      const correct=Boolean(user && user.active && timingSafeEqual(candidate,Buffer.from(user.passwordHash,'hex')));
      if(!correct){attempt.count++; if(attempt.count>=5){attempt.until=Date.now()+60_000;attempt.count=0;} loginAttempts.set(key,attempt);return fail(res,401,'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');}
      loginAttempts.delete(key);
      const id=randomBytes(32).toString('hex'); const csrfToken=randomBytes(24).toString('hex');
      sessions.set(id,{userId:user.id,csrf:csrfToken,expiresAt:Date.now()+8*60*60*1000,faceReviewTokens:new Map()});
      auditSafe(user,'auth.login','user',user.id,{});
      const secure=process.env.FACE_ATTENDANCE_SECURE_COOKIE==='1'?'; Secure':'';
      return json(res,200,{user:{id:user.id,username:user.username,displayName:user.displayName,role:user.role},csrf:csrfToken},{'Set-Cookie':`fa_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`});
    }

    if(req.method==='POST' && url.pathname==='/api/auth/logout') {
      const current=await auth(req,res,null,true); if(!current)return;
      sessions.delete(current.id); auditSafe(current.user,'auth.logout','user',current.user.id,{});
      return json(res,200,{ok:true},{'Set-Cookie':'fa_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
    }

    if(!url.pathname.startsWith('/api/') && req.method==='GET') return staticFile(url,res);
    if(!url.pathname.startsWith('/api/')) return fail(res,405,'ไม่รองรับคำขอนี้');

    // Authenticated mutations must be same-origin and carry the CSRF token returned by /api/me.
    const rolesWrite=['admin','teacher'];
    if(req.method==='POST' && url.pathname==='/api/users') {
      const current=await auth(req,res,['admin'],true);if(!current)return;
      const data=await body(req,8000);const username=String(data.username||'').trim();const displayName=String(data.displayName||'').trim();const password=String(data.password||'');const role=data.role;
      if(!/^[a-zA-Z0-9._-]{3,40}$/.test(username)||!displayName||password.length<12||!['admin','teacher'].includes(role))return fail(res,400,'ข้อมูลไม่ถูกต้อง: รหัสผ่านต้องอย่างน้อย 12 ตัวอักษร');
      const salt=randomBytes(16);const hash=scryptSync(password,salt,64);
      try{const result=db.prepare('INSERT INTO users(username,display_name,role,salt,password_hash) VALUES(?,?,?,?,?)').run(username,displayName,role,salt.toString('hex'),hash.toString('hex'));auditSafe(current.user,'user.create','user',result.lastInsertRowid,{role});return json(res,201,{id:result.lastInsertRowid,username,displayName,role});}catch{return fail(res,409,'ชื่อผู้ใช้นี้มีอยู่แล้ว');}
    }
    if(req.method==='PATCH' && /^\/api\/users\/\d+$/.test(url.pathname)) {
      const current=await auth(req,res,['admin'],true);if(!current)return;
      const id=Number(url.pathname.split('/').pop());const data=await body(req,8000);const active=data.active;
      if(id===current.user.id&&active===false)return fail(res,400,'ไม่สามารถปิดบัญชีที่กำลังใช้อยู่');
      if(typeof active!=='boolean')return fail(res,400,'สถานะไม่ถูกต้อง');
      if(!active){const activeAdmins=db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count;const target=db.prepare("SELECT role,active FROM users WHERE id=?").get(id);if(target?.role==='admin'&&target.active&&activeAdmins<=1)return fail(res,400,'ต้องมีบัญชีผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งบัญชี');}
      db.prepare('UPDATE users SET active=? WHERE id=?').run(active?1:0,id);auditSafe(current.user,'user.active','user',id,{active});return json(res,200,{ok:true});
    }

    if(req.method==='POST' && /^\/api\/students\/\d+\/consent$/.test(url.pathname)) {
      const current=await auth(req,res,['admin'],true);if(!current)return;
      const id=Number(url.pathname.split('/')[3]);const data=await body(req,8000);
      if(typeof data.granted!=='boolean')return fail(res,400,'สถานะความยินยอมไม่ถูกต้อง');
      if(data.granted){const s=db.prepare('SELECT active FROM students WHERE id=?').get(id);if(!s?.active)return fail(res,404,'ไม่พบนักเรียน');}
      if(!data.granted)db.prepare('DELETE FROM face_templates WHERE student_id=?').run(id);
      db.prepare('INSERT INTO face_consents(student_id,status,version,actor_id) VALUES(?,?,?,?)').run(id,data.granted?'granted':'revoked','consent-v1',current.user.id);
      auditSafe(current.user,data.granted?'consent.grant':'consent.revoke','student',id,{});
      return json(res,200,{consent:data.granted?'granted':'revoked'});
    }
    if(req.method==='POST' && url.pathname==='/api/face/enroll') {
      const current=await auth(req,res,['admin'],true);if(!current)return;
      const data=await body(req,80_000);const studentId=Number(data.studentId);const embedding=validateEmbedding(data.embedding);
      const consent=latestConsent(studentId);
      if(consent?.status!=='granted')return fail(res,403,'ต้องได้รับความยินยอมก่อนลงทะเบียนใบหน้า');
      const student=db.prepare('SELECT active FROM students WHERE id=?').get(studentId);if(!student?.active)return fail(res,404,'ไม่พบนักเรียน');
      const encrypted=encodeTemplate(embedding);
      db.prepare(`INSERT INTO face_templates(student_id,ciphertext,iv,auth_tag,dimensions,model_version,created_by)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,dimensions=excluded.dimensions,model_version=excluded.model_version,created_by=excluded.created_by,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(studentId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,embedding.length,'human-3.3.6-faceres',current.user.id);
      auditSafe(current.user,'face.enroll','student',studentId,{dimensions:embedding.length,model:'human-3.3.6-faceres'});
      return json(res,201,{ok:true,faceStatus:'registered'});
    }
    if(req.method==='POST' && url.pathname==='/api/face/verify') {
      const current=await auth(req,res,rolesWrite,true);if(!current)return;
      const data=await body(req,80_000);const query=validateEmbedding(data.embedding);
      const templates=db.prepare(`SELECT f.student_id,f.ciphertext,f.iv,f.auth_tag,f.dimensions,s.student_code,s.first_name,s.last_name,s.grade,s.room
        FROM face_templates f JOIN students s ON s.id=f.student_id WHERE s.active=1`).all();
      const candidates=[];
      for(const row of templates){
        const consent=latestConsent(row.student_id);if(consent?.status!=='granted')continue;
        const reference=decodeTemplate(row);if(reference.length!==query.length||reference.length!==row.dimensions)continue;
        candidates.push({row,similarity:cosine(query,reference)});
      }
      candidates.sort((a,b)=>b.similarity-a.similarity);
      const best=candidates[0];const runner=candidates[1];const threshold=getSettings().matchThreshold;
      if(!best || best.similarity<threshold || (runner && best.similarity-runner.similarity<0.04)) {
        auditSafe(current.user,'face.verify.uncertain','camera','local',{hasCandidates:Boolean(best)});
        return json(res,200,{status:'review',message:'ยังยืนยันตัวตนไม่ได้ กรุณาเช็กชื่อด้วยวิธีสำรองและให้ครูตรวจสอบ',candidate:null,similarity:best?Math.max(0,best.similarity):null,threshold});
      }
      const token=randomBytes(24).toString('hex');current.session.faceReviewTokens.set(token,{studentId:best.row.student_id,similarity:best.similarity,expiresAt:Date.now()+120_000});
      return json(res,200,{status:'teacher_review',message:'พบใบหน้าที่อาจตรงกัน · ครูต้องตรวจและยืนยันก่อนบันทึก',candidate:{studentCode:best.row.student_code,firstName:best.row.first_name,lastName:best.row.last_name,grade:best.row.grade,room:best.row.room},similarity:best.similarity,threshold,reviewToken:token});
    }
    if(req.method==='POST' && url.pathname==='/api/face/confirm') {
      const current=await auth(req,res,rolesWrite,true);if(!current)return;
      const data=await body(req,8000);const pending=current.session.faceReviewTokens.get(data.reviewToken);
      if(!pending||pending.expiresAt<Date.now())return fail(res,400,'ผลตรวจหมดอายุ กรุณาตรวจใบหน้าใหม่');
      current.session.faceReviewTokens.delete(data.reviewToken);
      try{const id=recordAttendance({studentId:pending.studentId,date:localClassDate(),status:statusByTime(),source:'face-reviewed',confidence:pending.similarity,user:current.user});return json(res,201,{id,status:'confirmed',studentId:pending.studentId,confidence:pending.similarity});}
      catch(error){if(error.errcode===2067||String(error.message||'').includes('UNIQUE constraint failed'))return fail(res,409,'นักเรียนคนนี้มีรายการเช็กชื่อในวันนี้แล้ว');throw error;}
    }

    const current=await auth(req,res,rolesWrite,true);if(!current)return;
    if(req.method==='POST' && url.pathname==='/api/students') {
      if(current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้');
      const data=await body(req,256000);const values=[String(data.studentCode||'').trim(),String(data.firstName||'').trim(),String(data.lastName||'').trim(),String(data.grade||'').trim(),String(data.room||'').trim()];
      if(values.some(value=>!value)||values.some(value=>value.length>80))return fail(res,400,'กรุณากรอกข้อมูลนักเรียนให้ครบ');
      try{const result=db.prepare('INSERT INTO students(student_code,first_name,last_name,grade,room,portrait_data) VALUES(?,?,?,?,?,?)').run(...values,portraitValue(data.portraitData));auditSafe(current.user,'student.create','student',result.lastInsertRowid,{hasPortrait:Boolean(data.portraitData)});return json(res,201,studentRow(db.prepare('SELECT * FROM students WHERE id=?').get(result.lastInsertRowid)));}catch(error){if(error.status)throw error;return fail(res,409,'รหัสนักเรียนซ้ำ');}
    }
    if(req.method==='PATCH' && /^\/api\/students\/\d+$/.test(url.pathname)) {
      if(current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้');
      const id=Number(url.pathname.split('/').pop());const data=await body(req,256000);const values=[String(data.studentCode||'').trim(),String(data.firstName||'').trim(),String(data.lastName||'').trim(),String(data.grade||'').trim(),String(data.room||'').trim()];
      if(values.some(value=>!value)||values.some(value=>value.length>80))return fail(res,400,'กรุณากรอกข้อมูลนักเรียนให้ครบ');
      try{const hasPortrait=Object.hasOwn(data,'portraitData');const statement=hasPortrait?`UPDATE students SET student_code=?,first_name=?,last_name=?,grade=?,room=?,portrait_data=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`:`UPDATE students SET student_code=?,first_name=?,last_name=?,grade=?,room=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`;db.prepare(statement).run(...values,...(hasPortrait?[portraitValue(data.portraitData)]:[]),id);auditSafe(current.user,'student.update','student',id,{portraitChanged:hasPortrait});return json(res,200,studentRow(db.prepare('SELECT * FROM students WHERE id=?').get(id)));}catch(error){if(error.status)throw error;return fail(res,409,'รหัสนักเรียนซ้ำ');}
    }
    if(req.method==='DELETE' && /^\/api\/students\/\d+$/.test(url.pathname)) {
      if(current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบจัดการข้อมูลนักเรียนได้');
      const id=Number(url.pathname.split('/').pop());db.prepare(`UPDATE students SET active=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);db.prepare('DELETE FROM face_templates WHERE student_id=?').run(id);auditSafe(current.user,'student.archive','student',id,{});return json(res,200,{ok:true});
    }
    if(req.method==='PATCH' && url.pathname==='/api/settings') {
      if(current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบเปลี่ยนการตั้งค่าได้');
      const data=await body(req,8000);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.startsAt)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.lateAfter)||data.lateAfter<data.startsAt||!Number.isFinite(data.matchThreshold)||data.matchThreshold<0.5||data.matchThreshold>0.99)return fail(res,400,'เวลาและเกณฑ์ความมั่นใจไม่ถูกต้อง');
      db.prepare(`UPDATE attendance_settings SET starts_at=?,late_after=?,match_threshold=?,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`).run(data.startsAt,data.lateAfter,data.matchThreshold,current.user.id);auditSafe(current.user,'settings.update','settings',1,{startsAt:data.startsAt,lateAfter:data.lateAfter,matchThreshold:data.matchThreshold});return json(res,200,getSettings());
    }
    if(req.method==='POST' && url.pathname==='/api/attendance') {
      const data=await body(req,8000);const studentId=Number(data.studentId);const date=parseDate(data.date,localClassDate());
      if(!Number.isInteger(studentId)||!attendanceStatus(data.status))return fail(res,400,'ข้อมูลการเข้าเรียนไม่ถูกต้อง');
      if(data.status==='absent'&&current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบบันทึกสถานะขาดเรียนได้');
      try{const id=recordAttendance({studentId,date,status:data.status,source:'manual',user:current.user,note:String(data.note||'').slice(0,240)});return json(res,201,{id,date,status:data.status});}catch(error){if(error.errcode===2067||String(error.message||'').includes('UNIQUE constraint failed'))return fail(res,409,'นักเรียนคนนี้มีรายการเช็กชื่อในวันนี้แล้ว');throw error;}
    }
    if(req.method==='PATCH' && /^\/api\/attendance\/\d+$/.test(url.pathname)) {
      if(current.user.role!=='admin')return fail(res,403,'เฉพาะผู้ดูแลระบบแก้ไขรายการเช็กชื่อได้');
      const id=Number(url.pathname.split('/').pop());const data=await body(req,8000);if(!attendanceStatus(data.status))return fail(res,400,'สถานะไม่ถูกต้อง');
      db.prepare(`UPDATE attendance_records SET status=?,checked_at=?,source='edit',reviewed_by=?,note=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(data.status,data.status==='absent'||data.status==='excused'?null:nowISO(),current.user.id,String(data.note||'').slice(0,240),id);auditSafe(current.user,'attendance.update','attendance',id,{status:data.status});return json(res,200,{ok:true});
    }
    return fail(res,404,'ไม่พบ API');
  } catch(error) {
    console.error(error);
    fail(res,error.status||500,error.status?error.message:'เกิดข้อผิดพลาดภายในระบบ');
  }
});

server.requestTimeout=30_000;
server.headersTimeout=35_000;
server.keepAliveTimeout=5_000;
server.listen(PORT,HOST,()=>{
  console.log(`FACE ATTENDANCE พร้อมใช้งานที่ http://${HOST}:${PORT}`);
  console.log(`ฐานข้อมูล: ${process.env.FACE_ATTENDANCE_DB || path.join(ROOT,'data','attendance.sqlite')}`);
  if(!encryptionKey)console.warn('ไม่ได้ตั้ง FACE_TEMPLATE_KEY: ระบบลงทะเบียนแม่แบบใบหน้าจะปิดไว้');
});
for(const [id,session] of sessions){if(session.expiresAt<Date.now())sessions.delete(id);}
