import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {appendOwnEvidenceCopy} from '../server/privacy-evidence-copy.mjs';
import {JPEG} from './avatar-fixture.mjs';
test('本人售后附件原样复制、完整性、体积和读取中归属变更',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE evidence_files(id TEXT,order_id TEXT,case_id TEXT,uploader_id TEXT,storage_key TEXT,name TEXT,mime TEXT,bytes INTEGER,sha256 TEXT,summary TEXT,created_at INTEGER)');
  const bytes=Buffer.from(JPEG,'base64'),sha=createHash('sha256').update(bytes).digest('hex');
  const insert=db.prepare('INSERT INTO evidence_files VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('file-own','order-own','case-own','own','PRIVATE_STORAGE_KEY','本人.jpg','image/jpeg',bytes.length,sha,'本人说明',1);
  insert.run('file-other','order-own','case-own','other','OTHER_STORAGE_KEY','OTHER_NAME_PRIVATE','image/jpeg',bytes.length,sha,'OTHER_SUMMARY_PRIVATE',1);
  const copy={complete:false,excluded:['售后附件、旧资料待核对'],sections:{account:{name:'合成账号'}}};
  let reads=0;const storage={get:async key=>{reads++;assert.equal(key,'PRIVATE_STORAGE_KEY');return bytes;}};
  const before=JSON.stringify(db.prepare('SELECT * FROM evidence_files').all());
  const result=await appendOwnEvidenceCopy(db,'own',copy,storage),file=result.sections.ownEvidenceUploads[0];
  assert.equal(reads,1);assert.equal(result.complete,false);assert.equal(result.sections.ownEvidenceUploads.length,1);
  assert.deepEqual(Buffer.from(file.contentBase64,'base64'),bytes);assert.equal(file.sha256,sha);assert.match(file.fileName,/^evidence-[a-f0-9]{24}\.jpg$/);
  for(const marker of ['PRIVATE_STORAGE_KEY','OTHER_STORAGE_KEY','OTHER_NAME_PRIVATE','OTHER_SUMMARY_PRIVATE','file-other'])assert.ok(!JSON.stringify(result).includes(marker));
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM evidence_files').all()),before);
  await assert.rejects(appendOwnEvidenceCopy(db,'own',copy,{get:async()=>null}),e=>e.status===409);
  await assert.rejects(appendOwnEvidenceCopy(db,'own',copy,{get:async()=>Buffer.from('bad')}),e=>e.status===409);
  db.prepare('UPDATE evidence_files SET bytes=? WHERE id=?').run(5*1024*1024,'file-own');
  await assert.rejects(appendOwnEvidenceCopy(db,'own',copy,{get:async()=>{throw Error('SHOULD_NOT_READ');}}),e=>e.status===409&&e.message.includes('较大'));
  db.prepare('UPDATE evidence_files SET bytes=? WHERE id=?').run(bytes.length,'file-own');
  await assert.rejects(appendOwnEvidenceCopy(db,'own',copy,{get:async()=>{db.prepare('UPDATE evidence_files SET uploader_id=? WHERE id=?').run('other','file-own');return bytes;}}),e=>e.status===409);
  db.prepare('UPDATE evidence_files SET uploader_id=? WHERE id=?').run('own','file-own');
  assert.equal((await appendOwnEvidenceCopy(db,'own',copy,storage)).sections.ownEvidenceUploads.length,1);
 }finally{db.close();}
});
