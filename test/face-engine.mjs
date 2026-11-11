import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let fixture=[];
class FakeHuman {
  async load(){}
  async warmup(){}
  async detect(){return {face:fixture};}
}
const sandbox={
  FA_CONFIG:{modelBasePath:'/test-models/'},
  Human:{Human:FakeHuman},
  document:{createElement(){return {
    width:0,height:0,
    getContext(){return {
      drawImage(){},
      getImageData(){return {data:new Uint8ClampedArray(32*24*4).fill(120)};}
    };}
  };}}
};
sandbox.window=sandbox;
vm.runInNewContext(fs.readFileSync(new URL('../face-engine.js',import.meta.url),'utf8'),sandbox);
const face=({score=0.95,size=120,embedding=new Array(1024).fill(.1)}={})=>({score,box:[80,60,size,size],embedding});
const video={videoWidth:640,videoHeight:480};
fixture=[];assert.equal((await sandbox.FaceEngine.inspect(video)).reason,'ไม่พบใบหน้าในภาพ');
fixture=[face(),face()];assert.equal((await sandbox.FaceEngine.inspect(video)).reason.includes('มากกว่าหนึ่ง'),true);
fixture=[face({score:.5})];assert.equal((await sandbox.FaceEngine.inspect(video)).reason.includes('ไม่ชัด'),true);
fixture=[face({size:45})];assert.equal((await sandbox.FaceEngine.inspect(video)).reason.includes('ไกลเกินไป'),true);
fixture=[face()];const accepted=await sandbox.FaceEngine.inspect(video);assert.equal(accepted.ok,true);assert.equal(accepted.embedding.length,1024);
fixture=[face({embedding:[1,2]})];assert.equal((await sandbox.FaceEngine.inspect(video)).reason.includes('สร้างแม่แบบ'),true);
console.log('ผ่าน: ไม่พบ/หลายใบหน้า, คะแนนต่ำ, ใบหน้าไกล และสร้างแม่แบบจาก fixture');
