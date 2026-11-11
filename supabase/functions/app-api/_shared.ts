import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
export const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const authClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });

export const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Cache-Control': 'no-store',
};
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
export async function authorize(req: Request, roles: string[] = ['admin', 'teacher']) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('กรุณาเข้าสู่ระบบ'), { status: 401 });
  const { data: { user }, error } = await authClient.auth.getUser(token);
  if (error || !user) throw Object.assign(new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'), { status: 401 });
  const { data: profile, error: profileError } = await db.from('users').select('id,email,display_name,role,active').eq('id', user.id).maybeSingle();
  if (profileError || !profile?.active) throw Object.assign(new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ระบบ'), { status: 403 });
  if (!roles.includes(profile.role)) throw Object.assign(new Error('ไม่มีสิทธิ์ดำเนินการนี้'), { status: 403 });
  return { user, profile, token };
}
export async function readBody(req: Request) {
  const length = Number(req.headers.get('content-length') || 0);
  if (length > 1_000_000) throw Object.assign(new Error('ข้อมูลคำขอมีขนาดใหญ่เกินกำหนด'), { status: 413 });
  try { return await req.json(); } catch { throw Object.assign(new Error('รูปแบบข้อมูลไม่ถูกต้อง'), { status: 400 }); }
}
export function bangkokDate(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => p.find(x => x.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function latestConsent(rows: Array<{status:string;recorded_at:string}> = []) {
  return [...rows].sort((a,b) => b.recorded_at.localeCompare(a.recorded_at))[0]?.status ?? 'none';
}
function hex(bytes: Uint8Array) { return [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string) { return new Uint8Array(value.match(/.{2}/g)?.map(x => parseInt(x, 16)) ?? []); }
export function bytesToPg(value: Uint8Array) { return `\\x${hex(value)}`; }
export function pgToBytes(value: string) { return unhex(value.replace(/^\\x/, '')); }
async function encryptionKey() {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(Deno.env.get('SUPABASE_URL')!), info: new TextEncoder().encode('face-attendance-template-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptEmbedding(embedding: number[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(embedding))));
  return { iv: bytesToPg(iv), ciphertext: bytesToPg(encrypted.slice(0, -16)), auth_tag: bytesToPg(encrypted.slice(-16)) };
}
export async function decryptEmbedding(row: {iv:string;ciphertext:string;auth_tag:string}) {
  const combined = new Uint8Array([...pgToBytes(row.ciphertext), ...pgToBytes(row.auth_tag)]);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: pgToBytes(row.iv) }, await encryptionKey(), combined);
  const value = JSON.parse(new TextDecoder().decode(clear));
  return Array.isArray(value) ? value as number[] : [];
}
export function validateEmbedding(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1024 || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw Object.assign(new Error('แม่แบบใบหน้าไม่ถูกต้อง'), { status: 400 });
  const norm = Math.sqrt(value.reduce((s,x)=>s+x*x,0));
  if (!Number.isFinite(norm) || norm < .00001) throw Object.assign(new Error('แม่แบบใบหน้าว่างเปล่า'), { status: 400 });
  return value.map(x => x / norm);
}
export function cosine(a:number[], b:number[]) {
  if (a.length !== b.length || !a.length) return -1;
  let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return dot/(Math.sqrt(aa*bb)||1);
}
export async function audit(actor:string, action:string, entity:string, entityId:string|number, details:Record<string,unknown>={}) {
  const { error } = await db.from('audit_logs').insert({ actor_id:actor, action, entity, entity_id:String(entityId), details });
  if (error) console.error('audit log write failed', error.code);
}
