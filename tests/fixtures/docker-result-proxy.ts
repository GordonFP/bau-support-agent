import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic MCP peer faults at the independent Docker/stdin boundary; the pinned native binary is unchanged.
export async function dockerResultProxy(root: string, mode: "coverage_empty" | "coverage_duplicate" | "coverage_unexpected" | "trace_other_target") {
  const path = join(root, "docker-result-proxy.mjs");
  await writeFile(path, `#!${process.execPath}
import {spawn} from 'node:child_process';
const args=process.argv.slice(2), child=spawn('/usr/local/bin/docker',args,{stdio:['pipe','pipe','inherit']}), pending=new Map(), mode=${JSON.stringify(mode)};
let input='',output='';
process.stdin.on('data',chunk=>{input+=chunk.toString();let at;while((at=input.indexOf('\\n'))>=0){const line=input.slice(0,at);input=input.slice(at+1);try{const request=JSON.parse(line);if(request.method==='tools/call')pending.set(request.id,request.params);}catch{}child.stdin.write(line+'\\n');}});
process.stdin.on('end',()=>child.stdin.end());
const edit=line=>{try{const message=JSON.parse(line), request=pending.get(message.id);if(!request||!message.result)return line;
const result=message.result;let data=result.structuredContent??JSON.parse(result.content[0].text);
if(request.name==='check_index_coverage'&&mode.startsWith('coverage_')){
if(mode==='coverage_empty')data.paths=[];
if(mode==='coverage_duplicate')data.paths=[...data.paths,...data.paths];
if(mode==='coverage_unexpected')data.paths=[...data.paths,{requested_path:'unexpected.ts',path:'unexpected.ts',freshness:'metadata_match'}];
}else if(request.name==='trace_path'&&mode==='trace_other_target'){
data={function:request.arguments.function_name,direction:request.arguments.direction,mode:'cross_service',callees:{cols:['name','hop','strategy','confidence'],groups:[{qn_prefix:'psp',rows:[['psp.verifyPsp',1,'ast',1]]}]},callees_total:1,callees_total_relation:'eq',truncated:false};
}else return line;
result.content=[{type:'text',text:JSON.stringify(data)}];if(result.structuredContent!==undefined)result.structuredContent=data;return JSON.stringify(message);
}catch{return line;}};
if(args[0]==='exec'&&args.includes('--interactive'))child.stdout.on('data',chunk=>{output+=chunk.toString();let at;while((at=output.indexOf('\\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);process.stdout.write(edit(line)+'\\n');}});else child.stdout.pipe(process.stdout);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('close',code=>{if(output)process.stdout.write(output);process.stdin.destroy();process.stdout.end(()=>process.exit(code??1));});
`);
  await chmod(path, 0o755); return path;
}
