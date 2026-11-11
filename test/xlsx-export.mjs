import assert from 'node:assert/strict';
import {buildAttendanceWorkbook} from '../xlsx-export.js';

const bytes=buildAttendanceWorkbook([['วันที่','ชื่อ'],['2026-11-11','กานต์ & <ทดสอบ>']]);
const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder();
let offset=0;const files=new Map();
while(view.getUint32(offset,true)===0x04034b50){const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true);const name=decoder.decode(bytes.subarray(offset+30,offset+30+nameLength));const start=offset+30+nameLength+extraLength;files.set(name,decoder.decode(bytes.subarray(start,start+size)));offset=start+size;}
assert.equal(view.getUint32(offset,true),0x02014b50,'valid ZIP central directory');
assert.equal(files.size,5);
assert.match(files.get('xl/workbook.xml'),/รายงานการเข้าเรียน/);
assert.match(files.get('xl/worksheets/sheet1.xml'),/กานต์ &amp; &lt;ทดสอบ&gt;/);
console.log('ผ่าน: สร้าง .xlsx ที่มี ZIP/OpenXML structure และข้อความไทย escaped ถูกต้อง');
