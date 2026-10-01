import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { validWithdrawal, withdrawalErrors } from '../lib/pos/cash-withdrawal.ts';

test('cash withdrawal Server Action guards first, preserves request IDs, fails safely and revalidates',async()=>{
  const source=await readFile(new URL('../app/(pos)/cash-withdrawal-action.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={}, calls=[], invalidations=[];
  let denied=false, transport=false, response={data:'saved-id',error:null};
  vm.runInNewContext(code,{exports,require(name){
    if(name==='next/cache') return {revalidatePath:(...args)=>invalidations.push(args)};
    if(name==='@/lib/pos/cash-withdrawal') return {validWithdrawal,withdrawalErrors};
    if(name==='@/lib/pos/server') return {posClient:async()=>{
      if(denied) throw new Error('GUARD_REDIRECT');
      return {rpc:async(name,args)=>{calls.push({name,args});if(transport) throw new Error('PRIVATE_PAYLOAD');return response;}};
    }};
    throw new Error('Unexpected import');
  }});
  const form=new FormData();
  form.set('request_id','00000000-0000-4000-8000-000000000001');
  form.set('session_id','00000000-0000-4000-8000-000000000002');
  form.set('amount','10.00');form.set('reason',' ხარჯი ');
  const initial={status:'idle',message:''};
  denied=true;
  await assert.rejects(exports.recordCashWithdrawal(initial,form),/GUARD_REDIRECT/);
  assert.equal(calls.length,0);denied=false;
  form.set('amount','0');assert.equal((await exports.recordCashWithdrawal(initial,form)).status,'error');
  assert.equal(calls.length,0);form.set('amount','10.00');
  assert.equal((await exports.recordCashWithdrawal(initial,form)).status,'success');
  assert.equal(calls[0].args.p_reason,'ხარჯი');
  assert.deepEqual(invalidations,[['/'],['/reports/register-sessions','layout']]);
  invalidations.length=0;
  for(const message of Object.keys(withdrawalErrors)) {
    response={data:null,error:{message}};
    const result=await exports.recordCashWithdrawal(initial,form);
    assert.equal(result.status,message==='REQUEST_CONFLICT'?'unknown':'error');
    assert.equal(result.message,withdrawalErrors[message]);
  }
  transport=true;
  const unknown=await exports.recordCashWithdrawal(initial,form);
  assert.equal(unknown.status,'unknown');assert.ok(!unknown.message.includes('PRIVATE_PAYLOAD'));
  transport=false;response={data:'saved-id',error:null};
  assert.equal((await exports.recordCashWithdrawal(unknown,form)).status,'success');
  assert.ok(calls.every(call=>call.name==='pos_record_cash_withdrawal' && call.args.p_request===form.get('request_id')));
  assert.equal(invalidations.length,2,'Failed calls must not claim success or refresh a successful result');
});
