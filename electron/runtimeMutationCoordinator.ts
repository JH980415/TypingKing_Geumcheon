import {randomUUID} from "node:crypto";

/** Stable across runtime replacements; context tokens never enter saved records. */
export class RuntimeMutationCoordinator {
  private currentEpoch=randomUUID();
  private pending=0;
  private lifecycles=0;
  private transitioning=false;
  private operation=Promise.resolve();

  get epoch():string {return this.currentEpoch;}

  assertEpoch(epoch:unknown):void {
    if(this.transitioning)throw new Error("PROFILE_BUSY_RECORDS");
    if(typeof epoch!=="string"||epoch!==this.currentEpoch)throw new Error("PROFILE_CONFIGURATION_CHANGED");
  }

  runMutation<T>(epoch:unknown,task:()=>T|Promise<T>):Promise<T> {
    this.assertEpoch(epoch);
    this.pending++;
    const result=this.operation.then(()=>{
      this.assertEpoch(epoch);
      return task();
    });
    this.operation=result.then(()=>undefined,()=>undefined);
    return result.finally(()=>{this.pending--;});
  }

  runTransition<T>(task:()=>T|Promise<T>):Promise<T> {
    if(this.transitioning||this.pending>0||this.lifecycles>0)throw new Error("PROFILE_BUSY_RECORDS");
    const nextEpoch=randomUUID();
    this.transitioning=true;
    return (async()=>{
      try {
        const result=await task();
        this.currentEpoch=nextEpoch;
        return result;
      } finally {this.transitioning=false;}
    })();
  }

  beginLifecycle(epoch:unknown):{epoch:string;release():void} {
    this.assertEpoch(epoch);
    this.lifecycles++;
    let released=false;
    return {epoch:this.currentEpoch,release:()=>{
      if(!released){released=true;this.lifecycles--;}
    }};
  }
}
