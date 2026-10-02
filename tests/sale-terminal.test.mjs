import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../app/components/sale-terminal.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function terminal() {
  let state = [], cursor = 0, tree;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(code, { exports, require(name) {
    if (name === 'react') return { useMemo: f => f(), useDeferredValue: v => v, useRef(initial) { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; }, useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; } };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-dom') return { useFormStatus: () => ({ pending: false }) };
    if (name === '@/app/(pos)/actions') return { completeSale() {}, loadCustomerPrices: async () => ({ ok: true, prices: [{ productId: '1', variantId: null, price: 80 }] }) };
    throw Error(name);
  } });
  const props = { items: [{kind:'product',id:'1',productId:'1',name:'Product',price:120}], paymentMethods:[{code:'cash',name:'Cash'},{code:'card',name:'Card'}], sessionId:'session',requestId:'request',customers:[{id:'customer',name:'Customer'}] };
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => nodes(n ?? null)); return [node, ...nodes(node.props?.children ?? null)]; }
  function render() { cursor=0; tree=exports.default(props); }
  const text = n => typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : text(n?.props?.children ?? '');
  return { render, reset() {state=[];render();}, click(label) { const n=nodes().find(n=>n.type==='button' && text(n)===label);assert.ok(n,label);n.props.onClick();render(); }, inputs() {return nodes().filter(n=>n.type==='input' && n.props.type==='number');}, change(n,value) {n.props.onChange({target:{value}});render();}, hidden(name) {return nodes().find(n=>n.props?.name===name).props.value;}, async selectCustomer() {nodes().find(n=>n.type==='select' && n.props.value==='').props.onChange({target:{value:'customer'}});await new Promise(r=>setTimeout(r,0));render();}, submit() {return nodes().find(n=>typeof n.type==='function');} };
}

test('terminal automatic/manual/split payments, decimal prices, discounts and fresh-sale state', async () => {
 const t=terminal();t.render();assert.equal(t.inputs()[0].props.value,'');
 t.click('დამატება');assert.equal(t.inputs().at(-1).props.value,'120.00');
 t.click('დამატება');assert.equal(t.inputs().at(-1).props.value,'240.00');
 t.change(t.inputs().at(-1),'25.50');t.click('დამატება');assert.equal(t.inputs().at(-1).props.value,'25.50');
 t.click('+ გადახდის დამატება');assert.equal(t.inputs().at(-1).props.value,'334.50');
 t.change(t.inputs()[1],'10.50');assert.equal(t.inputs().at(-1).props.value,'6.00');
 t.change(t.inputs()[2],'10');assert.equal(t.inputs().at(-1).props.value,'2.85');
 assert.deepEqual(JSON.parse(t.hidden('payments')),[{method:'cash',amount:'25.50'},{method:'card',amount:'2.85'}]);
 t.change(t.inputs()[2],'');assert.equal(t.inputs()[2].props.value,'');
 t.change(t.inputs()[1],'');assert.equal(t.inputs()[1].props.value,'');assert.equal(t.inputs().at(-1).props.value,'');assert.equal(t.submit().props.disabled,true);
 t.reset();assert.equal(t.hidden('items'),'[]');assert.equal(t.hidden('payments'),'[]');assert.equal(t.hidden('tracking_code'),'');assert.equal(t.hidden('customer_id'),'');assert.equal(t.submit().props.disabled,true);
 t.click('საბითუმო');await t.selectCustomer();t.click('დამატება');assert.equal(t.inputs().at(-1).props.value,'80.00');
 t.change(t.inputs().at(-1),'25');assert.equal(t.submit().props.disabled,false);
 t.change(t.inputs().at(-1),'0');assert.equal(t.hidden('payments'),'[]');assert.equal(t.submit().props.disabled,false);
 let selected=false;t.inputs().at(-1).props.onFocus({currentTarget:{value:'0',select(){selected=true;}}});assert.equal(selected,true);
 t.change(t.inputs().at(-1),'025');assert.equal(t.inputs().at(-1).props.value,'25');
 t.change(t.inputs().at(-1),'25.25');assert.equal(t.inputs().at(-1).props.value,'25.25');
});

test('successful action redirects to fresh GET and preserves the RPC request and session', async () => {
 const source=await readFile(new URL('../app/(pos)/actions.ts',import.meta.url),'utf8');
 const exports={},calls=[];
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,console,require(name){
  if(name==='next/navigation') return {redirect(path){throw Error(path);}};
  if(name==='next/cache') return {revalidatePath(){}};
  if(name==='@/lib/pos/server'){const fake=async()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:'sale',error:null};}});return {posClient:fake,rpcClient:fake};}
  return {};
 }});
 const f=new FormData();for(const [k,v] of Object.entries({request_id:'00000000-0000-4000-8000-000000000001',session_id:'00000000-0000-4000-8000-000000000002',sale_type:'retail',items:'[{"kind":"product","target":"1","quantity":"1"}]',payments:'[{"method":"cash","amount":"10.00"}]'}))f.set(k,v);
 await assert.rejects(exports.completeSale(f),/^Error: \/sales\/new\?saved=1$/);
 assert.equal(calls.length,1);assert.equal(calls[0].name,'pos_complete_sale');assert.equal(calls[0].args.p_request,f.get('request_id'));assert.equal(calls[0].args.p_session,f.get('session_id'));
 const page=await readFile(new URL('../app/(pos)/sales/new/page.tsx',import.meta.url),'utf8');
 assert.match(page,/const requestId = crypto.randomUUID\(\)/);assert.match(page,/<SaleTerminal\s+key=\{requestId\}/);assert.doesNotMatch(page,/\.rpc\("pos_complete_sale"/);
});
