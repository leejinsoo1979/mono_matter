import {existsSync} from 'node:fs';
import path from 'node:path';
/** Existing process values win, followed by .env.local and then .env. Never log values. */
export function loadEnvFiles(directory=process.cwd()){
  const protectedValues=new Map(Object.entries(process.env));
  for(const name of ['.env.local','.env']){
    const file=path.join(directory,name);if(!existsSync(file))continue;
    process.loadEnvFile(file);
    for(const [key,value] of protectedValues)if(value!==undefined)process.env[key]=value;
    for(const [key,value] of Object.entries(process.env))protectedValues.set(key,value);
  }
}
