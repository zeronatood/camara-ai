(() => {
  const KEY='faceAttendanceSession';let csrfToken='',currentUser=null,supabaseClient=null;
  const cloud=window.FA_CONFIG?.mode==='cloud';
  const publicPage=location.pathname.endsWith('/login.html')||location.pathname==='/login.html';
  if(cloud){
    if(!window.supabase?.createClient)throw new Error('โหลด Supabase client ไม่สำเร็จ');
    supabaseClient=window.supabase.createClient(FA_CONFIG.url,FA_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}});
  }
  async function getSession(){
    if(cloud){
      const {data:{session},error}=await supabaseClient.auth.getSession();
      if(error)throw error;if(!session){currentUser=null;sessionStorage.removeItem(KEY);return null;}
      const {data:profile,error:profileError}=await supabaseClient.from('users').select('id,email,display_name,role,active').eq('id',session.user.id).maybeSingle();
      if(profileError)throw new Error('ตรวจสอบสิทธิ์ผู้ใช้ไม่ได้');
      if(!profile||!profile.active){await supabaseClient.auth.signOut();currentUser=null;throw new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ระบบ กรุณาติดต่อผู้ดูแล');}
      currentUser={id:profile.id,username:profile.email||session.user.email,displayName:profile.display_name,role:profile.role};
      sessionStorage.setItem(KEY,JSON.stringify(currentUser));return currentUser;
    }
    const response=await fetch('/api/me',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    const data=await response.json();currentUser=data.user;csrfToken=data.csrf||'';
    if(currentUser)sessionStorage.setItem(KEY,JSON.stringify(currentUser));else sessionStorage.removeItem(KEY);return currentUser;
  }
  async function api(url,options={}){
    if(cloud){
      if(url==='/api/health'){
        const health=await fetch(`${FA_CONFIG.url}/functions/v1/app-api`,{method:'POST',headers:{'Content-Type':'application/json','apikey':FA_CONFIG.publishableKey},body:JSON.stringify({path:url,method:'GET'})});
        let result={};try{result=await health.json()}catch{}if(!health.ok)throw new Error(result.error||'เชื่อมต่อ Supabase ไม่สำเร็จ');return result;
      }
      const {data:{session},error}=await supabaseClient.auth.getSession();if(error||!session)throw new Error('กรุณาเข้าสู่ระบบใหม่');
      const method=(options.method||'GET').toUpperCase();let body=undefined;
      if(options.body!==undefined){try{body=JSON.parse(options.body)}catch{body=options.body}}
      const response=await fetch(`${FA_CONFIG.url}/functions/v1/app-api`,{method:'POST',headers:{'Content-Type':'application/json','apikey':FA_CONFIG.publishableKey,'Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({path:url,method,body})});
      let data={};try{data=await response.json()}catch{}
      if(response.status===401){await supabaseClient.auth.signOut();sessionStorage.removeItem(KEY);if(!publicPage)location.replace('/login.html');throw new Error(data.error||'กรุณาเข้าสู่ระบบใหม่');}
      if(!response.ok)throw new Error(data.error||`เกิดข้อผิดพลาด (${response.status})`);return data;
    }
    const headers=new Headers(options.headers||{});if(options.body!==undefined&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase())&&csrfToken)headers.set('X-CSRF-Token',csrfToken);
    const response=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store'});let data={};try{data=await response.json()}catch{}
    if(response.status===401&&!publicPage){sessionStorage.removeItem(KEY);location.replace('/login.html');throw new Error('กรุณาเข้าสู่ระบบใหม่');}
    if(!response.ok)throw new Error(data.error||`เกิดข้อผิดพลาด (${response.status})`);return data;
  }
  async function login({username,password}){
    if(cloud){
      const {error}=await supabaseClient.auth.signInWithPassword({email:String(username||'').trim(),password:String(password||'')});
      if(error)throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');const user=await getSession();if(!user)throw new Error('บัญชีนี้ยังไม่มีสิทธิ์เข้าระบบ');return user;
    }
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({username,password})});const data=await response.json();
    if(!response.ok)throw new Error(data.error||'เข้าสู่ระบบไม่สำเร็จ');currentUser=data.user;csrfToken=data.csrf||'';sessionStorage.setItem(KEY,JSON.stringify(currentUser));return currentUser;
  }
  async function logout(){if(cloud){await supabaseClient.auth.signOut();}else if(csrfToken){try{await api('/api/auth/logout',{method:'POST',body:JSON.stringify({})})}catch{}}sessionStorage.removeItem(KEY);location.replace('/login.html');}
  window.FA={api,login,getSession,logout,get user(){return currentUser},get csrf(){return csrfToken},get cloud(){return cloud}};
  document.addEventListener('DOMContentLoaded',async()=>{
    const footnote=document.getElementById('loginFootnote');if(footnote&&cloud)footnote.textContent='เชื่อมต่อ Supabase · ภาพและไฟล์ต้นฉบับไม่ถูกส่งไปจัดเก็บ';
    if(publicPage){try{if(await getSession())location.replace('/index.html')}catch{}return;}
    try{await getSession();if(!currentUser){location.replace('/login.html');return;}
      document.querySelectorAll('[data-user-name]').forEach(el=>el.textContent=currentUser.displayName);
      document.querySelectorAll('[data-user-role]').forEach(el=>el.textContent=currentUser.role==='admin'?'ผู้ดูแลระบบ':'ครู');
      document.querySelectorAll('[data-admin-only]').forEach(el=>{el.hidden=currentUser.role!=='admin';});
      document.querySelectorAll('[data-logout]').forEach(el=>el.addEventListener('click',logout));
      window.dispatchEvent(new CustomEvent('fa:ready',{detail:{user:currentUser}}));
    }catch(error){if(error?.message&&error.message.includes('ยังไม่ได้รับสิทธิ์')){const el=document.querySelector('[data-auth-error]');if(el)el.textContent=error.message;}location.replace('/login.html');}
  });
})();
