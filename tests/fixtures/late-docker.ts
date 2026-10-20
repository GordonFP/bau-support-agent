import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// An owned command-channel failure: the frontend exits before the daemon-side
// request is allowed to create its real container. The test reconciles that name.
export async function lateDocker(root: string, realDocker: string) {
  const command = join(root, "docker-command.mjs");
  const dispatched = join(root, "dispatched.json"), release = join(root, "release"), completed = join(root, "completed.json");
  await writeFile(command, `#!${process.execPath}
import { spawn, execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
const execute=promisify(execFile), args=process.argv.slice(2), real=${JSON.stringify(realDocker)};
if(args[0]==='worker'){
  while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,20));
  try{await execute(real,args.slice(1),{timeout:5000,maxBuffer:16384});writeFileSync(${JSON.stringify(completed)},JSON.stringify({created:true}));}
  catch{writeFileSync(${JSON.stringify(completed)},JSON.stringify({created:false}));}
}else if(args[0]==='run'){
  const worker=spawn(process.execPath,[import.meta.filename,'worker',...args],{detached:true,stdio:'ignore',env:{LANG:'C.UTF-8',TZ:'UTC'}});worker.unref();
  writeFileSync(${JSON.stringify(dispatched)},JSON.stringify({name:args[args.indexOf('--name')+1]}));
  process.exitCode=1;
}else{
  try{const result=await execute(real,args,{timeout:5000,maxBuffer:16384});process.stdout.write(result.stdout);process.stderr.write(result.stderr);}
  catch(error){process.stderr.write(error.stderr??'');process.exitCode=1;}
}
`);
  await chmod(command, 0o755);
  return { command,
    name: async () => (JSON.parse(await readFile(dispatched, "utf8")) as {name: string}).name,
    reconcile: async () => {
      await writeFile(release, "release");
      const deadline = performance.now() + 7000;
      for (;;) {
        try { return (JSON.parse(await readFile(completed, "utf8")) as {created: boolean}).created; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || performance.now() >= deadline) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } };
}
