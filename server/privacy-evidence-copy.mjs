import {createHash} from 'node:crypto';
import {BusinessError} from './market.mjs';
import {fileType} from './evidence.mjs';
const MAX_BYTES=5*1024*1024;
const fail=()=>{throw new BusinessError('本人附件缺失、变更或完整性异常，请人工核对后重新领取。',409);};
export async function appendOwnEvidenceCopy(db,userId,copy,storage){
 const query=db.prepare('SELECT id,order_id,case_id,storage_key,name,mime,bytes,sha256,summary,created_at FROM evidence_files WHERE uploader_id=? ORDER BY created_at,id LIMIT 5001');
 const plan=query.all(userId);
 if(plan.length>5000)throw new BusinessError('本人附件较多，需要分批人工交付。',409);
 let size=Buffer.byteLength(JSON.stringify(copy),'utf8');
 for(const row of plan){
  if(!Number.isSafeInteger(row.bytes)||row.bytes<=0||!['image/png','image/jpeg','image/webp','audio/mpeg','audio/wav'].includes(row.mime)||!/^[a-f0-9]{64}$/.test(row.sha256))fail();
  size+=Math.ceil(row.bytes/3)*4;
  if(size>MAX_BYTES)throw new BusinessError('本人附件较大，需要分批人工交付；未生成缺附件副本。',409);
 }
 const files=[];
 for(const row of plan){
  let content;try{content=await storage.get(row.storage_key);}catch{fail();}
  if(!(content instanceof Uint8Array))fail();
  const bytes=Buffer.from(content),sha256=createHash('sha256').update(bytes).digest('hex'),type=fileType(bytes);
  if(bytes.length!==row.bytes||sha256!==row.sha256||type?.[0]!==row.mime)fail();
  files.push({id:row.id,orderId:row.order_id,caseId:row.case_id,originalName:row.name,summary:row.summary,createdAt:row.created_at,
   fileName:'evidence-'+createHash('sha256').update(row.id).digest('hex').slice(0,24)+'.'+type[1][0],mime:row.mime,byteLength:bytes.length,sha256,contentBase64:bytes.toString('base64')});
 }
 if(JSON.stringify(query.all(userId))!==JSON.stringify(plan))fail();
 const result={...copy,sections:{...copy.sections,ownEvidenceUploads:files},excluded:copy.excluded.map(text=>text.replace('售后附件、','他人售后附件、'))};
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_BYTES)throw new BusinessError('副本较大，需要分批人工交付。',409);
 return result;
}
