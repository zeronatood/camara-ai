(() => {
  const MODEL_VERSION='human-3.3.6-faceres';
  let human=null;
  let loading=null;
  async function load() {
    if(loading)return loading;
    if(!window.Human?.Human)throw new Error('โหลดไลบรารีตรวจจับใบหน้าไม่สำเร็จ');
    const config={
      backend:'webgl',modelBasePath:window.FA_CONFIG?.modelBasePath||'/vendor/models/',cacheModels:true,
      face:{enabled:true,detector:{rotation:true,maxDetected:3,minConfidence:.65},mesh:{enabled:true},description:{enabled:true}},
      body:{enabled:false},hand:{enabled:false},object:{enabled:false},gesture:{enabled:false},emotion:{enabled:false},age:{enabled:false},gender:{enabled:false},antispoof:{enabled:false},liveness:{enabled:false}
    };
    human=new window.Human.Human(config);
    loading=(async()=>{await human.load();await human.warmup();return human;})();
    try{return await loading;}catch(error){loading=null;human=null;throw error;}
  }
  async function inspect(video) {
    await load();
    const result=await human.detect(video);
    const faces=Array.isArray(result.face)?result.face:[];
    if(faces.length!==1)return {ok:false,reason:faces.length===0?'ไม่พบใบหน้าในภาพ':'พบมากกว่าหนึ่งใบหน้า กรุณาให้มีนักเรียนในภาพเพียงคนเดียว',faces:faces.length};
    const face=faces[0];
    const box=Array.isArray(face.box)?{x:face.box[0],y:face.box[1],width:face.box[2],height:face.box[3]}:face.box||{};
    if(face.score!==undefined&&face.score<.8)return {ok:false,reason:'ภาพยังไม่ชัดพอ กรุณาจัดแสงและจัดตำแหน่งใหม่',faces:1};
    if((box.width||0)<90||(box.height||0)<90)return {ok:false,reason:'ใบหน้าอยู่ไกลเกินไป กรุณาขยับเข้าใกล้กล้อง',faces:1};
    if(!Array.isArray(face.embedding)||face.embedding.length<128)return {ok:false,reason:'สร้างแม่แบบจากภาพนี้ไม่สำเร็จ กรุณาถ่ายใหม่',faces:1};
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(video,0,0,32,24);
    const pixels=ctx.getImageData(0,0,32,24).data;let brightness=0;
    for(let i=0;i<pixels.length;i+=4)brightness+=(pixels[i]+pixels[i+1]+pixels[i+2])/3;
    brightness/=32*24;
    if(brightness<38||brightness>225)return {ok:false,reason:'แสงมืดหรือสว่างเกินไป กรุณาปรับแสงแล้วลองใหม่',faces:1};
    return {ok:true,embedding:Array.from(face.embedding),score:face.score??null,box,brightness,faces:1,modelVersion:MODEL_VERSION};
  }
  async function detect(video) { await load(); return human.detect(video); }
  window.FaceEngine={load,inspect,detect,get modelVersion(){return MODEL_VERSION;}};
})();
