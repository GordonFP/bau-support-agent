import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// Keep this isolated from Pi's known vendor declarations; check the actual Teams public closure in full.
const directory = mkdtempSync(resolve(".teams-consumer-"));
try {
  const fixture = join(directory, "consumer.mts");
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const compile = (activity) => {
    writeFileSync(fixture, `
import { App, type IHttpServerAdapter, type HttpRouteHandler } from '@microsoft/teams.apps';
import type { ILogger, Middleware } from '@microsoft/teams.common';
import { JwtValidator } from '@microsoft/teams.apps/dist/middleware/index.js';
import { PUBLIC, withOverrides } from '@microsoft/teams.api';
const logger: ILogger = {debug(){},info(){},warn(){},error(){},trace(){},log(){},child(){return this;}};
const middleware: Middleware = {async invoke(context,next){
  context.config.maxRedirects=0;context.config.maxContentLength=4096;context.config.maxBodyLength=65536;
  context.config.proxy=false;context.config.timeout=1000;context.config.signal=new AbortController().signal;
  context.config.responseType='json';context.config.transitional={silentJSONParsing:false,forcedJSONParsing:true};
  return next();
}};
let registered: HttpRouteHandler | undefined;
const adapter: IHttpServerAdapter = {registerRoute(_method,_path,handler){registered=handler;},async start(){},async stop(){}};
const app = new App({clientId:'synthetic-app',tenantId:'synthetic-tenant',token:async()=> 'synthetic-not-executed',
  serviceUrl:'http://127.0.0.1:1',apiClientSettings:{oauthUrl:'http://127.0.0.1:1'},
  client:{logger,timeout:1000,middlewares:[middleware]},logger,httpServerAdapter:adapter,
  cloud:withOverrides(PUBLIC,{openIdMetadataUrl:'http://127.0.0.1:1/.well-known/openidconfiguration'}),
  dangerouslyAllowUnauthenticatedRequests:false,telemetry:{agent365:false},state:false,plugins:[],oauth:{fetchUserToken:false}});
const validator = new JwtValidator({clientId:'synthetic-app',tenantId:'synthetic-tenant',clockTolerance:0,
  jwksUriOptions:{type:'uri',uri:'http://127.0.0.1:1/.well-known/keys'},
  validateIssuer:{allowedIssuer:'https://synthetic.invalid/tenant/v2.0'},validateScope:{requiredScope:'access_as_user'}},logger);
const flow = app.addOAuthFlow('synthetic-identity');
app.on('message',async ctx=>{const token=await flow.getToken(ctx);if(token)await validator.validateAccessToken(token);});
void registered;
void app.send('synthetic-conversation', ${activity});
`);
    return spawnSync(process.execPath, [compiler, "--ignoreConfig", "--strict", "--target", "ES2024", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--skipLibCheck", "false", "--types", "node", "--noEmit", fixture], { encoding: "utf8" });
  };
  const positive = compile("{type:'message',text:'synthetic',textFormat:'plain'}");
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  const negative = compile("123");
  assert.equal(negative.status, 1, negative.stdout + negative.stderr);
  const diagnostics = [...negative.stdout.matchAll(/error (TS\d+):/g)].map((match) => match[1]);
  assert.deepEqual(diagnostics, ["TS2769"], negative.stdout + negative.stderr);
  console.log("Teams full-declaration strict consumer: plain client accepted; invalid activity rejected TS2769.");
} finally { rmSync(directory, { recursive: true, force: true }); }
