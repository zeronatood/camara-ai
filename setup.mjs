import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, openDatabase } from './db.mjs';

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  console.error('พบไฟล์ .env แล้ว หากตั้งค่าไว้แล้วให้ใช้ npm start');
  process.exit(1);
}

const terminal = createInterface({ input: stdin, output: stdout });
try {
  console.log('ตั้งค่าระบบ FACE ATTENDANCE บนเครื่องนี้');
  console.log('รหัสผ่านจะปรากฏขณะพิมพ์ในเทอร์มินัล กรุณาเลือกใช้หน้าจอที่เป็นส่วนตัว');
  const username = (await terminal.question('ชื่อผู้ใช้ผู้ดูแลระบบ: ')).trim();
  const displayName = (await terminal.question('ชื่อที่แสดง: ')).trim();
  const password = await terminal.question('รหัสผ่าน (อย่างน้อย 12 ตัวอักษร): ');
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username) || !displayName || password.length < 12) {
    throw new Error('ชื่อผู้ใช้ต้องมี 3–40 ตัวอักษร (a-z, 0-9, . _ -), ชื่อแสดงต้องไม่ว่าง และรหัสผ่านต้องอย่างน้อย 12 ตัวอักษร');
  }
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(envPath, `FACE_TEMPLATE_KEY=${key}\nFACE_ATTENDANCE_HOST=127.0.0.1\nFACE_ATTENDANCE_PORT=8000\n`, { flag: 'wx', mode: 0o600 });
  const db = openDatabase();
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  db.prepare('INSERT INTO users(username, display_name, role, salt, password_hash) VALUES(?,?,?,?,?)')
    .run(username, displayName, 'admin', salt.toString('hex'), hash.toString('hex'));
  db.close();
  console.log(`\nตั้งค่าเสร็จแล้ว\nผู้ใช้: ${username}\nเริ่มระบบด้วย: npm start\nเปิด: http://localhost:8000`);
  console.log('เก็บไฟล์ .env และโฟลเดอร์ data ให้ปลอดภัย ทั้งคู่มีข้อมูลสำคัญ');
} catch (error) {
  if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
  console.error(`ตั้งค่าไม่สำเร็จ: ${error.message}`);
  process.exitCode = 1;
} finally {
  terminal.close();
}
