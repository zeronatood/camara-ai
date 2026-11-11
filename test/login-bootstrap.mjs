import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function run(setupRequired){
  const elements=new Map();
  for(const id of ['loginForm','loginError','loginSubmit','healthStatus','setupNotice'])elements.set(id,{hidden:id==='setupNotice',textContent:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){}});
  const context={document:{getElementById:id=>elements.get(id)},FA:{cloud:true,api:async()=>({ok:true,backend:'supabase',setupRequired})}};
  vm.runInNewContext(fs.readFileSync(new URL('../login.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setTimeout(resolve,0));
  return elements;
}
const fresh=await run(true);assert.equal(fresh.get('setupNotice').hidden,false);assert.equal(fresh.get('loginForm').hidden,true);
const initialized=await run(false);assert.equal(initialized.get('setupNotice').hidden,true);assert.equal(initialized.get('loginForm').hidden,false);
console.log('ผ่าน: Login แสดงการตั้งค่าผู้ดูแลเฉพาะเมื่อยังไม่มี profile');
