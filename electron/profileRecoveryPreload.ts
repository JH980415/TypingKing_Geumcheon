import {contextBridge,ipcRenderer} from "electron";
contextBridge.exposeInMainWorld("profileRecovery",{
 authenticate:(password:string)=>ipcRenderer.invoke("recovery:authenticate",password),
 choose:()=>ipcRenderer.invoke("recovery:choose"),
 apply:()=>ipcRenderer.invoke("recovery:apply")
});
