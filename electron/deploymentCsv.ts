import {parse} from "csv-parse/sync";
import {stringify} from "csv-stringify/sync";
import type {ProfileSession} from "./deploymentProfile";
export function appendDeploymentCsvContext(csv:string,session:ProfileSession):string {
 const rows=parse(csv,{bom:true}) as string[][];
 if(!rows.length)throw new Error("CSV_EMPTY");
 const index=rows[0].findIndex(label=>label==="기록 ID" || label==="record_id");
 if(index<0)throw new Error("CSV_RECORD_ID_MISSING");
 const values=rows.slice(1).map(row=>{const match=/^gsc26-(pc0[1-4])-/i.exec(row[index]);if(!match)throw new Error("CSV_DEVICE_ID_INVALID");return [...row,match[1].toUpperCase(),session.sessionId,String(session.dayNo),String(session.roundNo)];});
 return "\uFEFF"+stringify([[...rows[0],"device_id","session_id","day_no","round_no"],...values]);
}
