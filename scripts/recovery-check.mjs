import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {localConfig} from '../server/config.mjs';
import {restoreEncryptedSnapshot,readBackupKey} from './secure-backup.mjs';
import {inspectPaymentJournal,inspectLocalPaymentChannel} from '../server/payment-journal.mjs';

// Restore only into an invocation-owned private scratch directory, never into live data.
export async function checkEncryptedRecovery(source,key,options={}) {
  const parent=realpathSync(path.dirname(path.resolve(source)));
  const scratch=mkdtempSync(path.join(parent,'.delta-recovery-'));
  let db,channel;
  try {
    const restored=await restoreEncryptedSnapshot(source,path.join(scratch,'data'),key,options);
    db=new DatabaseSync(path.join(restored,'auth.sqlite'),{readOnly:true});
    channel=new DatabaseSync(path.join(restored,'mock-services.sqlite'),{readOnly:true});
    const journal=inspectPaymentJournal(db),provider=inspectLocalPaymentChannel(db,channel);
    const checks={journal:journal.ok,historyCovered:journal.legacyUncovered===0,channel:provider.ok,pendingConfirmed:provider.pendingConfirmed===0};
    return {scope:'isolated-encrypted-recovery',ok:Object.values(checks).every(Boolean),checks};
  } finally {
    channel?.close();db?.close();
    const resolved=realpathSync(scratch);
    if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('.delta-recovery-'))throw Error('RECOVERY_CLEANUP_BOUNDARY');
    rmSync(resolved,{recursive:true});
  }
}

if(import.meta.main) {
  try {
    localConfig();
    if(!process.argv[2])throw Error('BACKUP_REQUIRED');
    const result=await checkEncryptedRecovery(path.resolve(process.argv[2]),readBackupKey(process.env.BACKUP_KEY_FILE),{authSecret:process.env.BETTER_AUTH_SECRET,authKeyRef:process.env.AUTH_KEY_REF});
    console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
  }catch{console.error(JSON.stringify({event:'recovery_check',ok:false,code:'RECOVERY_FAILED'}));process.exitCode=1;}
}
